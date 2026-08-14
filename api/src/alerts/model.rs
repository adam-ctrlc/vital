use chrono::{DateTime, Utc};
use libsql::Row;
use serde::Serialize;
use uuid::Uuid;

use crate::error::AppResult;
use crate::users::model::{parse_timestamp, parse_uuid};

#[derive(Debug, Clone, Serialize)]
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
#[derive(Debug, Clone, Serialize)]
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

/// The columns every alert query selects, in the order the readers below expect.
///
/// A macro rather than a constant so `concat!` can splice it into a statement: the SQL
/// stays a compile-time literal, and no query is ever assembled from runtime strings.
///
/// The prefix is a table alias for the joined query, where a bare `id` or `created_at`
/// would be ambiguous between `alerts` and `readings`. Passing it in keeps the column
/// order defined once instead of once per query shape.
// One column per line, each with its prefix. rustfmt would otherwise split every pair
// across two lines and the column list would stop reading like a column list.
#[rustfmt::skip]
macro_rules! alert_columns {
    ($prefix:literal) => {
        concat!(
            $prefix, "id, ",
            $prefix, "reading_id, ",
            $prefix, "kind, ",
            $prefix, "message, ",
            $prefix, "value, ",
            $prefix, "threshold, ",
            $prefix, "created_at, ",
            $prefix, "acknowledged_at, ",
            $prefix, "acknowledged_by, ",
            $prefix, "response_ms"
        )
    };
}

pub(crate) use alert_columns;

impl Alert {
    /// Reads a row selected as `alert_columns!("")`.
    ///
    /// By index rather than by name: the column list is one macro shared by every
    /// query that builds an alert, so the order is fixed in a single place.
    pub(crate) fn from_row(row: &Row) -> AppResult<Self> {
        Ok(Self {
            id: row.get(0)?,
            reading_id: row.get(1)?,
            kind: row.get(2)?,
            message: row.get(3)?,
            value: row.get(4)?,
            threshold: row.get(5)?,
            created_at: parse_timestamp(&row.get::<String>(6)?)?,
            acknowledged_at: parse_optional_timestamp(row, 7)?,
            acknowledged_by: parse_optional_uuid(row, 8)?,
            response_ms: row.get(9)?,
        })
    }
}

impl AlertWithReading {
    /// Reads a row selected as `alert_columns!("")` followed by the eight measurement
    /// columns of the joined reading.
    pub(crate) fn from_row(row: &Row) -> AppResult<Self> {
        Ok(Self {
            id: row.get(0)?,
            reading_id: row.get(1)?,
            kind: row.get(2)?,
            message: row.get(3)?,
            value: row.get(4)?,
            threshold: row.get(5)?,
            created_at: parse_timestamp(&row.get::<String>(6)?)?,
            acknowledged_at: parse_optional_timestamp(row, 7)?,
            acknowledged_by: parse_optional_uuid(row, 8)?,
            response_ms: row.get(9)?,
            voltage_v: row.get(10)?,
            current_a: row.get(11)?,
            temperature_c: row.get(12)?,
            apparent_power_va: row.get(13)?,
            power_w: row.get(14)?,
            power_factor: row.get(15)?,
            frequency_hz: row.get(16)?,
            energy_kwh: row.get(17)?,
        })
    }
}

/// An unacknowledged alert has no acknowledgement time and no acknowledger, and a left
/// joined reading that has been pruned has neither. Both are read as text first because
/// SQLite has no date or uuid type to hand them back as.
fn parse_optional_timestamp(row: &Row, index: i32) -> AppResult<Option<DateTime<Utc>>> {
    row.get::<Option<String>>(index)?
        .as_deref()
        .map(parse_timestamp)
        .transpose()
}

fn parse_optional_uuid(row: &Row, index: i32) -> AppResult<Option<Uuid>> {
    row.get::<Option<String>>(index)?
        .as_deref()
        .map(parse_uuid)
        .transpose()
}
