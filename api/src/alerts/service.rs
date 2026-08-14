use crate::alerts::model::{KIND_OVERLOAD, KIND_TEMPERATURE};
use crate::error::AppResult;
use crate::notifications;
use crate::readings::model::Reading;
use crate::settings::model::Settings;
use crate::sheets::Sheets;
use crate::sheets::store;

/// Opens alerts for any threshold the reading crosses.
pub async fn evaluate(sheets: &Sheets, reading: &Reading, settings: &Settings) -> AppResult<()> {
    if let Some(apparent) = reading.apparent_power_va {
        if apparent >= settings.load_threshold_va {
            raise(
                sheets,
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
                sheets,
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

/// Opens an alert only when nothing of the same kind is still unacknowledged, so a fast
/// heartbeat cannot flood the alert list with duplicates of one ongoing condition.
///
/// The list is de-duplicated; the notification is not. An unacknowledged condition is
/// announced again on the store's renotify interval, against the same alert rather than a
/// new one, so the history stays one row per condition while the phone keeps being told
/// the transformer is still over its limit.
///
/// The three store calls below are the three steps this used to run as SQL, in the same
/// order, because the order is the policy: claim a re-announcement first, then treat an
/// open alert as reason to stay quiet, and only then open a new one.
async fn raise(
    sheets: &Sheets,
    reading_id: i64,
    kind: &str,
    message: &str,
    value: f64,
    threshold: f64,
) -> AppResult<()> {
    // Postgres found the due alert and stamped it in one statement under `for update
    // skip locked`, so of two readings arriving together exactly one came away holding
    // it. The store now reads and writes in separate calls with a round trip between,
    // so both can see the same alert as due and both announce it. The interval is a
    // floor on how often a phone is told, no longer a promise that it is told once.
    if let Some(alert) = store::alerts::claim_renotify(sheets, kind).await? {
        tracing::info!(kind, value, alert_id = alert.id, "condition ongoing, announcing again");
        notifications::service::notify_alert(sheets, &alert).await;

        return Ok(());
    }

    // Nothing was claimed, which means either no open alert of this kind, or one that
    // has been announced too recently to say again.
    if let Some(open) = store::alerts::open_of_kind(sheets, kind).await? {
        tracing::debug!(kind, value, open = open.id, "condition ongoing, announced too recently");

        return Ok(());
    }

    // This check and the insert below are no longer one atomic step. The partial unique
    // index that used to turn a lost race into a conflict has no equivalent in a
    // spreadsheet, so two ingests that both find nothing open here will both append: one
    // ongoing overload can become two alerts and two pushes to every device. There is
    // nothing to catch here any more, which is why the insert result is taken straight.
    let alert = store::alerts::insert(sheets, reading_id, kind, message, value, threshold).await?;

    tracing::info!(kind, value, threshold, "alert raised");

    // Awaited rather than spawned: a serverless function may be frozen the moment it
    // responds, which would cut a detached task off mid-flight. This only runs when a
    // new alert is opened, so it is not on the common path.
    notifications::service::notify_alert(sheets, &alert).await;

    Ok(())
}
