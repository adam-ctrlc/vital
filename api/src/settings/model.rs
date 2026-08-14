use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Settings {
    /// Raises an alert and marks a reading as overload. Advisory: nothing is switched.
    pub load_threshold_va: f64,
    /// Opens the relay. Always above the alarm, so an operator gets a window to act
    /// before the board acts for them.
    pub trip_threshold_va: f64,
    pub temp_threshold_c: f64,
    /// How long the board waits before each reclose attempt, in seconds. Operator owned
    /// rather than fixed in the firmware, because how long a transformer should sit
    /// disconnected depends on the transformer, and changing it should not need a reflash.
    pub reclose_delay_seconds: i32,
    /// How long the load must stay above the trip level before the contacts open.
    ///
    /// Easily confused with the wait above, and the opposite of it: this one runs while
    /// the load is still connected and decides whether to cut it, that one runs while it
    /// is disconnected and decides when to try again.
    pub trip_confirm_seconds: i32,
    pub source_mode: String,
    pub updated_at: DateTime<Utc>,
}

#[derive(Debug, Clone, Copy, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SettingsUpdate {
    pub load_threshold_va: f64,
    pub trip_threshold_va: f64,
    pub temp_threshold_c: f64,
    pub reclose_delay_seconds: i32,
    /// Absent means "leave it as it is", not "reset it to the default".
    ///
    /// Optional because the field arrived after the app did, and a build in somebody's
    /// hand still sends the four fields it knew about. Required, that build's settings
    /// screen would start failing; defaulted, it would quietly undo this value every
    /// time anyone saved a threshold from it.
    #[serde(default)]
    pub trip_confirm_seconds: Option<i32>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SourceUpdate {
    pub source_mode: String,
}
