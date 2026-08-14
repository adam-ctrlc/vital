use std::fmt;
use std::str::FromStr;

use chrono::{DateTime, Utc};
use libsql::Row;
use serde::{Deserialize, Serialize};

use crate::error::{AppError, AppResult};

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Status {
    Normal,
    Overload,
}

impl Status {
    #[must_use]
    pub const fn as_str(self) -> &'static str {
        match self {
            Self::Normal => "normal",
            Self::Overload => "overload",
        }
    }
}

impl fmt::Display for Status {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(self.as_str())
    }
}

impl FromStr for Status {
    type Err = AppError;

    fn from_str(value: &str) -> Result<Self, Self::Err> {
        match value {
            "normal" => Ok(Self::Normal),
            "overload" => Ok(Self::Overload),
            other => Err(AppError::BadRequest(format!("invalid status: {other}"))),
        }
    }
}

/// A raw measurement, either simulated or pushed by hardware.
///
/// Every field is optional: a board may carry only a temperature sensor, or only
/// the electrical sensors, and still report what it has. A missing value stays
/// missing all the way out rather than defaulting to zero.
#[derive(Debug, Clone, Copy, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ReadingInput {
    #[serde(default)]
    pub voltage_v: Option<f64>,
    #[serde(default)]
    pub current_a: Option<f64>,
    #[serde(default)]
    pub temperature_c: Option<f64>,
    #[serde(default)]
    pub power_w: Option<f64>,
    #[serde(default)]
    pub power_factor: Option<f64>,
    #[serde(default)]
    pub frequency_hz: Option<f64>,
    #[serde(default)]
    pub energy_kwh: Option<f64>,
    /// Whether the relay was passing load when this was measured.
    ///
    /// Reported by the board rather than inferred, because inferring it from zero amps
    /// cannot tell an open contact from a load that is simply switched off.
    #[serde(default)]
    pub relay_closed: Option<bool>,
}

impl ReadingInput {
    /// A reading with only the three core sensors present.
    #[must_use]
    pub const fn core(voltage_v: f64, current_a: f64, temperature_c: f64) -> Self {
        Self {
            voltage_v: Some(voltage_v),
            current_a: Some(current_a),
            temperature_c: Some(temperature_c),
            power_w: None,
            power_factor: None,
            frequency_hz: None,
            energy_kwh: None,
            relay_closed: None,
        }
    }

    /// A reading with no measurements at all, used when hardware has never reported.
    #[must_use]
    pub const fn empty() -> Self {
        Self {
            voltage_v: None,
            current_a: None,
            temperature_c: None,
            power_w: None,
            power_factor: None,
            frequency_hz: None,
            energy_kwh: None,
            relay_closed: None,
        }
    }

    /// Whether this carries no measurement at all.
    ///
    /// A row of nothing but nulls is not a reading, it is a timestamp: it says the
    /// board was talking without saying anything about the transformer. Stored, they
    /// count toward `total`, occupy pages of the log, and drag every average in the
    /// trend toward a value nobody measured.
    ///
    /// Deliberately ignores the relay position. A contact state is not a measurement of
    /// the transformer, so a payload carrying only that still has nothing to record.
    #[must_use]
    pub const fn is_empty(&self) -> bool {
        self.voltage_v.is_none()
            && self.current_a.is_none()
            && self.temperature_c.is_none()
            && self.power_w.is_none()
            && self.power_factor.is_none()
            && self.frequency_hz.is_none()
            && self.energy_kwh.is_none()
    }
}

/// Timestamps are text in this database, so every read parses.
///
/// SQLite has no date type, so instants are RFC 3339 written by
/// `strftime('%Y-%m-%dT%H:%M:%fZ', ...)`. `datetime('now')` would look close enough in
/// the row and fail here: it has no T and no zone, and chrono will not parse it.
///
/// Shared with the service rather than repeated there: within one domain, how a stored
/// instant is read back should only be possible to get wrong in one place.
pub(crate) fn parse_timestamp(raw: &str) -> AppResult<DateTime<Utc>> {
    DateTime::parse_from_rfc3339(raw)
        .map(|at| at.with_timezone(&Utc))
        .map_err(|error| AppError::Upstream(format!("unreadable timestamp {raw:?}: {error}")))
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Reading {
    pub id: i64,
    pub voltage_v: Option<f64>,
    pub current_a: Option<f64>,
    pub temperature_c: Option<f64>,
    pub apparent_power_va: Option<f64>,
    pub status: String,
    pub source: String,
    pub power_w: Option<f64>,
    pub power_factor: Option<f64>,
    pub frequency_hz: Option<f64>,
    pub energy_kwh: Option<f64>,
    /// Whether the relay was passing load when this row was measured.
    pub relay_closed: Option<bool>,
    pub recorded_at: DateTime<Utc>,
}

impl Reading {
    /// The columns `from_row` reads, in the order it reads them.
    ///
    /// Shared by every statement that returns a reading, because decoding is positional
    /// now: a select list and its decoder are one fact rather than two that have to be
    /// kept in agreement, and a column quietly inserted in the middle of one of four
    /// copies of this list would misread every field after it rather than fail.
    pub const COLUMNS: &'static str = "id, voltage_v, current_a, temperature_c, apparent_power_va, \
         status, source, power_w, power_factor, frequency_hz, energy_kwh, relay_closed, recorded_at";

    /// Reads the row by column index, in the order `COLUMNS` selects.
    ///
    /// `serde` cannot be used here: the struct is renamed to camelCase for the app, so a
    /// field-name lookup would go hunting for a `voltageV` column, and `relayClosed` would
    /// be refused the integer SQLite actually stores.
    pub(crate) fn from_row(row: &Row) -> AppResult<Self> {
        Ok(Self {
            id: row.get(0)?,
            voltage_v: row.get(1)?,
            current_a: row.get(2)?,
            temperature_c: row.get(3)?,
            apparent_power_va: row.get(4)?,
            status: row.get(5)?,
            source: row.get(6)?,
            power_w: row.get(7)?,
            power_factor: row.get(8)?,
            frequency_hz: row.get(9)?,
            energy_kwh: row.get(10)?,
            // Stored as the integer 0 or 1, which libsql turns back into a bool. Null
            // stays null: a simulated reading has no contacts to report.
            relay_closed: row.get(11)?,
            recorded_at: parse_timestamp(&row.get::<String>(12)?)?,
        })
    }
}

/// The dashboard heartbeat payload: live values plus the thresholds they are judged against.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LiveReading {
    pub voltage_v: Option<f64>,
    pub current_a: Option<f64>,
    pub temperature_c: Option<f64>,
    /// Derived from `temperature_c` on the way out; never stored, so the two cannot drift.
    pub temperature_f: Option<f64>,
    pub apparent_power_va: Option<f64>,
    pub status: Status,
    pub load_threshold_va: f64,
    /// Where the board opens the relay. Sent so the dashboard can show how much room is
    /// left before the load is cut, not just before the alarm sounds.
    pub trip_threshold_va: f64,
    pub temp_threshold_c: f64,
    pub temp_threshold_f: f64,
    pub load_percent: Option<f64>,
    pub over_temperature: bool,
    pub power_w: Option<f64>,
    pub power_factor: Option<f64>,
    pub frequency_hz: Option<f64>,
    pub energy_kwh: Option<f64>,
    /// Q = sqrt(S^2 - P^2). Present only when real power is, since it cannot be
    /// recovered from apparent power alone.
    pub reactive_power_var: Option<f64>,
    /// VA left before the load threshold. Negative once over. `None` without a load reading.
    pub headroom_va: Option<f64>,
    pub recorded_at: DateTime<Utc>,
    /// True when the feed is derived from the clock rather than a real board.
    pub simulated: bool,
    /// True when a hardware reading arrived inside the connected window.
    pub connected: bool,
    /// Whether the relay is passing load, as of the newest reading.
    pub relay_closed: Option<bool>,
    /// The board's address on its own network, when it has reported one.
    ///
    /// Here rather than only on `/device/status`, which is admin only, because every
    /// role's dashboard wants it: on a shared network the app reads the board directly
    /// and only falls back to this endpoint when it cannot. A private address is far
    /// less telling than the SSID and firmware version beside it, which stay admin only.
    pub device_ip: Option<String>,
}

/// Reactive power from the power triangle. `None` unless both apparent and real power are present.
#[must_use]
pub fn reactive_power(apparent_power_va: Option<f64>, power_w: Option<f64>) -> Option<f64> {
    match (apparent_power_va, power_w) {
        (Some(apparent), Some(real)) => {
            // Clamped at zero: sensor noise can make P marginally exceed S.
            Some(apparent.mul_add(apparent, -(real * real)).max(0.0).sqrt())
        }
        _ => None,
    }
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TrendPoint {
    pub day: DateTime<Utc>,
    // Nullable since 0011 made the underlying columns nullable: a day of readings
    // from a board with no PZEM leaves avg/max over apparent_power_va as SQL NULL,
    // and a day with no probe does the same to the temperature average.
    pub avg_power_va: Option<f64>,
    pub max_power_va: Option<f64>,
    pub avg_temperature_c: Option<f64>,
    pub samples: i64,
}

impl TrendPoint {
    pub(crate) fn from_row(row: &Row) -> AppResult<Self> {
        Ok(Self {
            day: parse_timestamp(&row.get::<String>(0)?)?,
            avg_power_va: row.get(1)?,
            max_power_va: row.get(2)?,
            avg_temperature_c: row.get(3)?,
            samples: row.get(4)?,
        })
    }
}

#[cfg(test)]
mod input_tests {
    use super::ReadingInput;

    #[test]
    fn an_input_with_nothing_in_it_is_empty() {
        assert!(ReadingInput::empty().is_empty());
    }

    #[test]
    fn a_single_measurement_is_enough() {
        // The README documents this exact body: a board with only a probe still reports.
        let probe_only = ReadingInput {
            temperature_c: Some(31.5),
            ..ReadingInput::empty()
        };
        assert!(!probe_only.is_empty());

        // Every field on its own has to count, or a board reporting just that one would
        // be silently dropped.
        let energy_only = ReadingInput {
            energy_kwh: Some(12.5),
            ..ReadingInput::empty()
        };
        assert!(!energy_only.is_empty());
    }

    #[test]
    fn a_relay_position_on_its_own_is_still_empty() {
        // The contact state describes the protection, not the transformer, so a board
        // that reports only where its relay sits has measured nothing. Counting it
        // would let a heartbeat write a row of nulls into the log and the trend.
        let relay_only = ReadingInput {
            relay_closed: Some(true),
            ..ReadingInput::empty()
        };
        assert!(relay_only.is_empty());

        // Still stored when it rides along with a real measurement.
        let tripped_under_load = ReadingInput {
            current_a: Some(4.2),
            relay_closed: Some(false),
            ..ReadingInput::empty()
        };
        assert!(!tripped_under_load.is_empty());
    }

    #[test]
    fn a_zero_is_a_measurement_not_an_absence() {
        // Zero amps is a real reading of an idle transformer. Treating it as nothing
        // would drop exactly the samples that prove the load was off.
        let idle = ReadingInput {
            current_a: Some(0.0),
            ..ReadingInput::empty()
        };
        assert!(!idle.is_empty());
    }
}
