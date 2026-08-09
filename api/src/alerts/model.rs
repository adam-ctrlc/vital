use chrono::{DateTime, Utc};
use serde::Serialize;
use uuid::Uuid;

#[derive(Debug, Clone, Serialize, sqlx::FromRow)]
#[serde(rename_all = "camelCase")]
pub struct Alert {
    pub id: i64,
    pub reading_id: Option<i64>,
    pub kind: String,
    pub message: String,
    pub value: f64,
    pub threshold: f64,
    pub created_at: DateTime<Utc>,
    pub acknowledged_at: Option<DateTime<Utc>>,
    pub acknowledged_by: Option<Uuid>,
    pub response_ms: Option<i64>,
}

/// An alert together with the reading that triggered it.
///
/// The measurements live on the reading, not the alert, which stores only the value
/// that crossed and the threshold it crossed. Answering "how did it get there" therefore
/// means joining, and that is what this carries.
///
/// Every measurement is optional twice over: the join is a left join because an alert
/// can outlive its reading, and a board without a PZEM reports only some fields even
/// when the reading is there.
#[derive(Debug, Clone, Serialize, sqlx::FromRow)]
#[serde(rename_all = "camelCase")]
pub struct AlertWithReading {
    pub id: i64,
    pub reading_id: Option<i64>,
    pub kind: String,
    pub message: String,
    pub value: f64,
    pub threshold: f64,
    pub created_at: DateTime<Utc>,
    pub acknowledged_at: Option<DateTime<Utc>>,
    pub acknowledged_by: Option<Uuid>,
    pub response_ms: Option<i64>,
    pub voltage_v: Option<f64>,
    pub current_a: Option<f64>,
    pub temperature_c: Option<f64>,
    pub apparent_power_va: Option<f64>,
    pub power_w: Option<f64>,
    pub power_factor: Option<f64>,
    pub frequency_hz: Option<f64>,
    pub energy_kwh: Option<f64>,
}

pub const KIND_OVERLOAD: &str = "overload";
pub const KIND_TEMPERATURE: &str = "temperature";
