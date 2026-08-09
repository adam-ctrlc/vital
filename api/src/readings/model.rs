use std::fmt;
use std::str::FromStr;

use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};

use crate::error::AppError;

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
        }
    }

    /// Whether this carries no measurement at all.
    ///
    /// A row of nothing but nulls is not a reading, it is a timestamp: it says the
    /// board was talking without saying anything about the transformer. Stored, they
    /// count toward `total`, occupy pages of the log, and drag every average in the
    /// trend toward a value nobody measured.
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

#[derive(Debug, Clone, Serialize, sqlx::FromRow)]
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
    pub recorded_at: DateTime<Utc>,
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

#[derive(Debug, Clone, Serialize, sqlx::FromRow)]
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
