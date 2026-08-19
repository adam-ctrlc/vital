use libsql::{Connection, params};

use crate::alerts::model::{Alert, KIND_OVERLOAD, KIND_TEMPERATURE, alert_columns};
use crate::error::AppResult;
use crate::notifications;
use crate::readings::model::Reading;
use crate::settings::model::Settings;

/// Opens alerts for any threshold the reading crosses.
pub async fn evaluate(conn: &Connection, reading: &Reading, settings: &Settings) -> AppResult<()> {
    if let Some(apparent) = reading.apparent_power_va {
        if apparent >= settings.load_threshold_va {
            raise(
                conn,
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
                conn,
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
    conn: &Connection,
    reading_id: i64,
    kind: &str,
    message: &str,
    value: f64,
    threshold: f64,
) -> AppResult<()> {
    // Claims the right to re-announce and reads the alert in one statement, so two
    // concurrent readings cannot both decide they are the one that is due. The row is
    // only returned when it was actually claimed.
    //
    // Postgres held the candidate with `for update skip locked` while it decided. There
    // is no equivalent here and none is needed: SQLite admits one writer at a time, so
    // this UPDATE is applied whole against a row nobody else is touching. What replaces
    // the lock is the due condition living in the WHERE clause rather than in a
    // preceding read. Whoever runs second matches against the `last_notified_at` the
    // first one just wrote, no longer satisfies the predicate, and is handed no row.
    //
    // The `order by ... limit 1` is gone too: `alerts_one_active_per_kind` permits only
    // one unacknowledged alert per kind, so the predicate already names a single row.
    //
    // `strftime('%s', ...)` is whole seconds since the epoch on both sides, which is
    // what turns "at least sixty seconds have passed" into arithmetic.
    let mut claimed = conn
        .query(
            concat!(
                "update alerts
                 set last_notified_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now'),
                     updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
                 where kind = ?1
                   and acknowledged_at is null
                   and (last_notified_at is null
                        or strftime('%s', 'now') - strftime('%s', last_notified_at) >= ?2)
                 returning ",
                alert_columns!("")
            ),
            params![kind, RENOTIFY_AFTER_SECONDS],
        )
        .await?;

    if let Some(row) = crate::db::first_row(&mut claimed).await? {
        let alert = Alert::from_row(&row)?;

        tracing::info!(
            kind,
            value,
            alert_id = alert.id,
            "condition ongoing, announcing again"
        );
        notifications::service::notify_alert(conn, &alert).await;

        return Ok(());
    }

    // Nothing was claimed, which means either no open alert of this kind, or one that
    // has been announced too recently to say again.
    let mut active = conn
        .query(
            "select id from alerts where kind = ?1 and acknowledged_at is null limit 1",
            [kind],
        )
        .await?;

    if let Some(row) = crate::db::first_row(&mut active).await? {
        let open: i64 = row.get(0)?;

        tracing::debug!(
            kind,
            value,
            open,
            "condition ongoing, announced too recently"
        );

        return Ok(());
    }

    let inserted = conn
        .query(
            concat!(
                "insert into alerts (reading_id, kind, message, value, threshold, last_notified_at)
                 values (?1, ?2, ?3, ?4, ?5, strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
                 returning ",
                alert_columns!("")
            ),
            params![reading_id, kind, message, value, threshold],
        )
        .await;

    let alert = match inserted {
        Ok(mut rows) => match crate::db::first_row(&mut rows).await? {
            Some(row) => Alert::from_row(&row)?,
            // An insert that succeeded always returns the row it wrote, so there is
            // nothing here to announce and nothing to report.
            None => return Ok(()),
        },
        // Lost the race: another request opened the same condition between the check
        // above and this insert. The partial unique index `alerts_one_active_per_kind`
        // is what turns that into a conflict rather than a second alert and a second
        // push to every device. Nothing to report, the condition is already raised.
        Err(error) if crate::error::is_unique_violation(&error) => return Ok(()),
        Err(error) => return Err(error.into()),
    };

    tracing::info!(kind, value, threshold, "alert raised");

    // Awaited rather than spawned: a serverless function may be frozen the moment it
    // responds, which would cut a detached task off mid-flight. This only runs when a
    // new alert is opened, so it is not on the common path.
    notifications::service::notify_alert(conn, &alert).await;

    Ok(())
}
