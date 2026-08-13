use sqlx::PgPool;

use crate::alerts::model::{Alert, KIND_OVERLOAD, KIND_TEMPERATURE};
use crate::error::AppResult;
use crate::notifications;
use crate::readings::model::Reading;
use crate::settings::model::Settings;

/// Opens alerts for any threshold the reading crosses.
pub async fn evaluate(pool: &PgPool, reading: &Reading, settings: &Settings) -> AppResult<()> {
    if let Some(apparent) = reading.apparent_power_va {
        if apparent >= settings.load_threshold_va {
            raise(
                pool,
                reading.id,
                KIND_OVERLOAD,
                &format!("Load reached {apparent:.0} VA"),
                apparent,
                settings.load_threshold_va,
            )
            .await?;
        }
    }

    if let Some(temperature) = reading.temperature_c {
        if temperature >= settings.temp_threshold_c {
            raise(
                pool,
                reading.id,
                KIND_TEMPERATURE,
                &format!("Temperature reached {temperature:.1} °C"),
                temperature,
                settings.temp_threshold_c,
            )
            .await?;
        }
    }

    Ok(())
}

/// How long an ongoing condition waits before announcing itself again.
///
/// An alarm that speaks once and then goes quiet while the fault continues is not an
/// alarm. This is deliberately far longer than the reading interval: the point is to
/// keep saying it, not to say it every few seconds until the phone is thrown across
/// the room.
const RENOTIFY_AFTER_SECONDS: i64 = 60;

/// Opens an alert only when nothing of the same kind is still unacknowledged, so a fast
/// heartbeat cannot flood the alert list with duplicates of one ongoing condition.
///
/// The list is de-duplicated; the notification is not. An unacknowledged condition is
/// announced again every RENOTIFY_AFTER_SECONDS, against the same alert rather than a
/// new one, so the history stays one row per condition while the phone keeps being
/// told the transformer is still over its limit.
async fn raise(
    pool: &PgPool,
    reading_id: i64,
    kind: &str,
    message: &str,
    value: f64,
    threshold: f64,
) -> AppResult<()> {
    // Claims the right to re-announce and reads the alert in one statement, so two
    // concurrent readings cannot both decide they are the one that is due. The row is
    // only returned when it was actually claimed.
    let due = sqlx::query_as::<_, Alert>(
        "update alerts
         set last_notified_at = now()
         where id = (
             select id from alerts
             where kind = $1
               and acknowledged_at is null
               and (last_notified_at is null
                    or now() - last_notified_at >= make_interval(secs => $2::double precision))
             order by created_at
             limit 1
             for update skip locked
         )
         returning id, reading_id, kind, message, value, threshold, created_at,
                   acknowledged_at, acknowledged_by, response_ms",
    )
    .bind(kind)
    .bind(RENOTIFY_AFTER_SECONDS as f64)
    .fetch_optional(pool)
    .await?;

    if let Some(alert) = due {
        tracing::info!(kind, value, alert_id = alert.id, "condition ongoing, announcing again");
        notifications::service::notify_alert(pool, &alert).await;

        return Ok(());
    }

    // Nothing was claimed, which means either no open alert of this kind, or one that
    // has been announced too recently to say again.
    let active: Option<i64> =
        sqlx::query_scalar("select id from alerts where kind = $1 and acknowledged_at is null limit 1")
            .bind(kind)
            .fetch_optional(pool)
            .await?;

    if let Some(open) = active {
        tracing::debug!(kind, value, open, "condition ongoing, announced too recently");

        return Ok(());
    }

    let inserted = sqlx::query_as::<_, Alert>(
        "insert into alerts (reading_id, kind, message, value, threshold, last_notified_at)
         values ($1, $2, $3, $4, $5, now())
         returning id, reading_id, kind, message, value, threshold, created_at,
                   acknowledged_at, acknowledged_by, response_ms",
    )
    .bind(reading_id)
    .bind(kind)
    .bind(message)
    .bind(value)
    .bind(threshold)
    .fetch_one(pool)
    .await;

    let alert = match inserted {
        Ok(alert) => alert,
        // Lost the race: another request opened the same condition between the check
        // above and this insert. The partial unique index added in 0015 is what turns
        // that into a conflict rather than a second alert and a second push to every
        // device. Nothing to report, the condition is already raised.
        Err(error) if crate::error::is_unique_violation(&error) => return Ok(()),
        Err(error) => return Err(error.into()),
    };

    tracing::info!(kind, value, threshold, "alert raised");

    // Awaited rather than spawned: a serverless function may be frozen the moment it
    // responds, which would cut a detached task off mid-flight. This only runs when a
    // new alert is opened, so it is not on the common path.
    notifications::service::notify_alert(pool, &alert).await;

    Ok(())
}
