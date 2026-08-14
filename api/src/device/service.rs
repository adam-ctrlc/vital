use chrono::Utc;

use crate::device::model::{DeviceStatus, Heartbeat, HeartbeatAck};
use crate::error::AppResult;
use crate::readings::service as readings_service;
use crate::settings::service as settings_service;
use crate::sheets::store;
use crate::sheets::Sheets;
use crate::time::local_label;

/// Records a firmware heartbeat into the singleton telemetry row, then returns the
/// current alarm thresholds so the board can adopt any operator change. Absent fields
/// coalesce to the stored value, so a partial heartbeat never clears what it omits.
pub async fn record_heartbeat(sheets: &Sheets, heartbeat: &Heartbeat) -> AppResult<HeartbeatAck> {
    // Postgres read and cleared the pending command in the same `update ... returning`
    // that recorded the heartbeat, so exactly one heartbeat could ever be handed it.
    // A spreadsheet has no such statement: this is a read and then a write, and two
    // heartbeats arriving together can both see the same command and both act on it.
    // Accepted rather than worked around, because a relay command is a level and not a
    // pulse. The firmware treats a repeated open or close as idempotent, applying it to
    // a relay already in that position and moving nothing, so a duplicate costs nothing
    // where a lost command would leave an operator pressing a button that does nothing.
    let relay_command = store::device::record_heartbeat(sheets, heartbeat).await?;

    let settings = settings_service::load(sheets).await?;

    Ok(HeartbeatAck {
        load_threshold_va: settings.load_threshold_va,
        trip_threshold_va: settings.trip_threshold_va,
        temp_threshold_c: settings.temp_threshold_c,
        reclose_delay_seconds: settings.reclose_delay_seconds,
        relay_command,
    })
}

/// Queues an operator's relay command for the board's next heartbeat.
///
/// Overwrites anything still pending rather than queueing behind it. Someone who
/// pressed open and then close means close: replaying the first would leave the relay
/// in the state they changed their mind about.
///
/// The write is no longer serialized against a heartbeat. One queued in the moment
/// between a heartbeat's read and its write is overwritten by that heartbeat before any
/// board sees it, and the operator has to press again.
pub async fn request_relay_command(sheets: &Sheets, command: &str) -> AppResult<()> {
    store::device::request_relay_command(sheets, command).await
}

/// Live link state. The identity fields come from the newest reported telemetry and
/// are null until the firmware has reported in; `connected` and the last-seen fields
/// are driven by the newest hardware reading; `simulated` follows the source mode.
pub async fn status(sheets: &Sheets) -> AppResult<DeviceStatus> {
    let telemetry = store::device::load(sheets).await?;

    let settings = settings_service::load(sheets).await?;
    let now = Utc::now();

    let latest_hardware = store::readings::latest(sheets, Some("hardware")).await?;
    let connected = latest_hardware.as_ref().is_some_and(|reading| {
        readings_service::is_within_connected_window(reading.recorded_at, now)
    });
    let relay_closed = latest_hardware.as_ref().and_then(|reading| reading.relay_closed);
    let (last_seen_at, last_seen_label) = match latest_hardware {
        Some(reading) => (
            Some(reading.recorded_at),
            Some(local_label(reading.recorded_at)),
        ),
        None => (None, None),
    };

    Ok(DeviceStatus {
        connected,
        relay_locked_out: telemetry.relay_locked_out,
        relay_closed,
        device_id: telemetry.device_id,
        firmware: telemetry.firmware,
        ip_address: telemetry.ip_address,
        signal_dbm: telemetry.signal_dbm,
        uptime_seconds: telemetry.uptime_seconds,
        ssid: telemetry.ssid,
        last_seen_at,
        last_seen_label,
        simulated: settings.source_mode != "hardware",
    })
}
