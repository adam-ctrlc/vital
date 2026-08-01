use chrono::Utc;
use sqlx::PgPool;

use crate::device::model::{DeviceStatus, Heartbeat, HeartbeatAck};
use crate::error::AppResult;
use crate::readings::service as readings_service;
use crate::settings::service as settings_service;
use crate::time::local_label;

type Telemetry = (
    Option<String>,
    Option<String>,
    Option<String>,
    Option<String>,
    Option<i32>,
    Option<i64>,
);

/// Records a firmware heartbeat into the singleton telemetry row, then returns the
/// current alarm thresholds so the board can adopt any operator change. Absent fields
/// coalesce to the stored value, so a partial heartbeat never clears what it omits.
pub async fn record_heartbeat(pool: &PgPool, heartbeat: &Heartbeat) -> AppResult<HeartbeatAck> {
    sqlx::query(
        "update device_telemetry set
             device_id = coalesce($1, device_id),
             firmware = coalesce($2, firmware),
             ssid = coalesce($3, ssid),
             ip_address = coalesce($4, ip_address),
             signal_dbm = coalesce($5, signal_dbm),
             uptime_seconds = coalesce($6, uptime_seconds),
             reported_at = now()
         where id = 1",
    )
    .bind(&heartbeat.device_id)
    .bind(&heartbeat.firmware)
    .bind(&heartbeat.ssid)
    .bind(&heartbeat.ip_address)
    .bind(heartbeat.signal_dbm)
    .bind(heartbeat.uptime_seconds)
    .execute(pool)
    .await?;

    let settings = settings_service::load(pool).await?;

    Ok(HeartbeatAck {
        load_threshold_va: settings.load_threshold_va,
        trip_threshold_va: settings.trip_threshold_va,
        temp_threshold_c: settings.temp_threshold_c,
    })
}

/// Live link state. The identity fields come from the newest reported telemetry and
/// are null until the firmware has reported in; `connected` and the last-seen fields
/// are driven by the newest hardware reading; `simulated` follows the source mode.
pub async fn status(pool: &PgPool) -> AppResult<DeviceStatus> {
    let telemetry: Option<Telemetry> = sqlx::query_as(
        "select device_id, firmware, ssid, ip_address, signal_dbm, uptime_seconds
         from device_telemetry where id = 1",
    )
    .fetch_optional(pool)
    .await?;
    let (device_id, firmware, ssid, ip_address, signal_dbm, uptime_seconds) =
        telemetry.unwrap_or((None, None, None, None, None, None));

    let settings = settings_service::load(pool).await?;
    let now = Utc::now();

    let latest_hardware = readings_service::latest_hardware(pool).await?;
    let connected = latest_hardware.as_ref().is_some_and(|reading| {
        readings_service::is_within_connected_window(reading.recorded_at, now)
    });
    let (last_seen_at, last_seen_label) = match latest_hardware {
        Some(reading) => (
            Some(reading.recorded_at),
            Some(local_label(reading.recorded_at)),
        ),
        None => (None, None),
    };

    Ok(DeviceStatus {
        connected,
        device_id,
        firmware,
        ip_address,
        signal_dbm,
        uptime_seconds,
        ssid,
        last_seen_at,
        last_seen_label,
        simulated: settings.source_mode != "hardware",
    })
}
