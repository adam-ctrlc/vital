use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};

/// Live link state for the ESP32. Connection and last-seen come from hardware
/// readings; the identity fields come from the newest reported telemetry and are
/// null until the firmware has reported in.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DeviceStatus {
    pub connected: bool,
    /// The relay is open and will stay open until an admin resets it.
    pub relay_locked_out: bool,
    /// The relay's position as of the newest hardware reading, or null if it has never
    /// reported one. Distinct from the lockout: a relay can be open without being
    /// locked out, while it waits out a reclose delay.
    pub relay_closed: Option<bool>,
    pub device_id: Option<String>,
    pub firmware: Option<String>,
    pub ip_address: Option<String>,
    pub signal_dbm: Option<i32>,
    pub uptime_seconds: Option<i64>,
    pub ssid: Option<String>,
    pub last_seen_at: Option<DateTime<Utc>>,
    pub last_seen_label: Option<String>,
    /// True when the live feed is simulated rather than driven by hardware.
    pub simulated: bool,
}

/// Telemetry the firmware self-reports. Every field is optional so a heartbeat can
/// carry only what changed; absent fields keep their stored value.
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Heartbeat {
    pub device_id: Option<String>,
    pub firmware: Option<String>,
    pub ssid: Option<String>,
    pub ip_address: Option<String>,
    pub signal_dbm: Option<i32>,
    pub uptime_seconds: Option<i64>,
    /// Whether the relay is open and out of attempts. Reported so an operator can see
    /// that the load is off deliberately rather than the board being dead.
    #[serde(default)]
    pub relay_locked_out: Option<bool>,
}

/// Returned in the heartbeat response so the board can adopt the operator's alarm
/// thresholds. The firmware compares these to its stored values and re-applies only
/// when they differ, which is how an edit made while it was offline reaches it.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct HeartbeatAck {
    pub load_threshold_va: f64,
    /// The level at which the board opens the relay, sent alongside the alarm so both
    /// stages of the protection scheme come from one operator edit.
    pub trip_threshold_va: f64,
    pub temp_threshold_c: f64,
    /// What an admin has asked the relay to do, if anything: "open" or "close".
    ///
    /// Cleared as it is handed over, so the board acts on it exactly once. A command
    /// that stayed set would re-apply on every heartbeat and undo whatever the
    /// protection decided in between.
    pub relay_command: Option<String>,
    /// How long to wait before each reclose attempt, in seconds.
    pub reclose_delay_seconds: i32,
}
