use std::ops::RangeInclusive;

use axum::extract::{Query, State};
use axum::routing::get;
use axum::{Json, Router};
use serde::Deserialize;

use crate::auth::extract::{AdminUser, AuthUser, DeviceAuth};
use crate::error::{AppError, AppResult};
use crate::page::{Page, Paging};
use crate::readings::model::{LiveReading, Reading, ReadingInput, Status, TrendPoint};
use crate::readings::service;
use crate::search;
use crate::state::AppState;

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct HistoryQuery {
    pub status: Option<String>,
    /// Restricts to a single feed: 'hardware' or 'simulator'.
    pub source: Option<String>,
    /// Free-text search over status, source, power and the local timestamp.
    pub q: Option<String>,
    pub limit: Option<i64>,
    pub offset: Option<i64>,
}

const DEFAULT_LIMIT: i64 = 20;
const MAX_LIMIT: i64 = 500;

/// Trims a filter and treats blank as "no filter", so `?q=` behaves like an absent param.
fn filter(value: Option<String>) -> Option<String> {
    value
        .map(|raw| raw.trim().to_owned())
        .filter(|trimmed| !trimmed.is_empty())
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TrendQuery {
    #[serde(default = "default_days")]
    pub days: i64,
}

const fn default_days() -> i64 {
    7
}

/// Physically plausible envelopes for a 1 KVA transformer on a 230 V / 60 Hz supply,
/// set far above anything the hardware can produce. They are here to bound what gets
/// stored, not to model the device: `voltage * current` silently becomes
/// `f64::INFINITY` once both sides are large enough, and Postgres stores that happily,
/// after which the alert message reads "inf VA", `loadPercent` serialises as null, and
/// the day's trend bucket is poisoned for good.
const VOLTAGE_RANGE: RangeInclusive<f64> = 0.0..=1_000.0;
const CURRENT_RANGE: RangeInclusive<f64> = 0.0..=100.0;
const POWER_RANGE: RangeInclusive<f64> = -100_000.0..=100_000.0;
const TEMPERATURE_RANGE: RangeInclusive<f64> = -50.0..=300.0;
const FREQUENCY_RANGE: RangeInclusive<f64> = 0.0..=100.0;
const ENERGY_RANGE: RangeInclusive<f64> = 0.0..=1_000_000.0;
const POWER_FACTOR_RANGE: RangeInclusive<f64> = 0.0..=1.0;

/// Rejects an out-of-range measurement. An absent field is always fine: the README
/// documents that an ingest may carry any subset. Non-finite values fail too, since
/// `contains` is false for NaN.
fn in_range(value: Option<f64>, range: RangeInclusive<f64>, field: &str) -> AppResult<()> {
    match value {
        Some(measured) if !range.contains(&measured) => Err(AppError::BadRequest(format!(
            "{field} must be between {} and {}",
            range.start(),
            range.end()
        ))),
        _ => Ok(()),
    }
}

pub fn router() -> Router<AppState> {
    Router::new()
        .route("/latest", get(latest))
        .route("/", get(history).post(ingest))
        .route("/trend", get(trend))
}

/// Dashboard heartbeat. Poll this as fast as you like.
async fn latest(State(state): State<AppState>, _auth: AuthUser) -> AppResult<Json<LiveReading>> {
    let reading = service::live(&state.sheets, state.sample_interval_ms).await?;

    Ok(Json(reading))
}

/// Hardware ingest. Real sensors push measurements here, authenticated by the
/// `x-device-key` header. Fails closed: no configured key means no ingest.
async fn ingest(
    State(state): State<AppState>,
    _device: DeviceAuth,
    Json(body): Json<ReadingInput>,
) -> AppResult<Json<Reading>> {
    // Rejected here as well as in the service, so a board sending nothing gets a clear
    // 400 without a round trip to the database.
    if body.is_empty() {
        return Err(AppError::BadRequest(
            "at least one measurement is required".to_owned(),
        ));
    }
    in_range(body.voltage_v, VOLTAGE_RANGE, "voltage")?;
    in_range(body.current_a, CURRENT_RANGE, "current")?;
    in_range(body.power_w, POWER_RANGE, "power")?;
    in_range(body.temperature_c, TEMPERATURE_RANGE, "temperature")?;
    in_range(body.frequency_hz, FREQUENCY_RANGE, "frequency")?;
    in_range(body.energy_kwh, ENERGY_RANGE, "energy")?;
    in_range(body.power_factor, POWER_FACTOR_RANGE, "power factor")?;

    let settings = crate::settings::service::load(&state.sheets).await?;
    let reading = service::record(&state.sheets, body, "hardware", &settings).await?;

    Ok(Json(reading))
}

async fn history(
    State(state): State<AppState>,
    _admin: AdminUser,
    Query(query): Query<HistoryQuery>,
) -> AppResult<Json<Page<Reading>>> {
    let (limit, offset) =
        Paging::new(query.limit, query.offset).resolve(DEFAULT_LIMIT, MAX_LIMIT);
    let status = filter(query.status);
    let source = filter(query.source);
    let q = filter(query.q).map(|needle| search::escape_like(&needle));

    if let Some(status) = status.as_deref() {
        status.parse::<Status>()?;
    }
    if let Some(source) = source.as_deref() {
        match source {
            "hardware" | "simulator" => {}
            other => return Err(AppError::BadRequest(format!("invalid source: {other}"))),
        }
    }

    // Ninety days back, which is the furthest the trend endpoint looks and therefore
    // the furthest anything asks for. Reading every month ever recorded to answer a
    // twenty row page would get slower for the rest of the system's life.
    let to = chrono::Utc::now();
    let from = to - chrono::Duration::days(90);

    let mut matching: Vec<Reading> = crate::sheets::store::readings::between(&state.sheets, from, to)
        .await?
        .into_iter()
        .filter(|reading| status.as_deref().is_none_or(|wanted| reading.status == wanted))
        .filter(|reading| source.as_deref().is_none_or(|wanted| reading.source == wanted))
        .filter(|reading| {
            // The raw needle, not an escaped one. `escape_like` exists for LIKE, and
            // escaping first would make a search for a literal percent sign look for
            // the backslash the escape added.
            q.as_deref()
                .is_none_or(|needle| crate::sheets::store::readings::matches(reading, needle))
        })
        .collect();

    // Newest first, which is what the SQL ordering gave and what the logs screen shows.
    matching.sort_by(|left, right| right.recorded_at.cmp(&left.recorded_at));

    let total = i64::try_from(matching.len()).unwrap_or(i64::MAX);
    let rows: Vec<Reading> = matching
        .into_iter()
        .skip(usize::try_from(offset).unwrap_or(0))
        .take(usize::try_from(limit).unwrap_or(usize::MAX))
        .collect();


    Ok(Json(Page::new(rows, total, limit, offset)))
}

async fn trend(
    State(state): State<AppState>,
    _admin: AdminUser,
    Query(query): Query<TrendQuery>,
) -> AppResult<Json<Vec<TrendPoint>>> {
    let days = query.days.clamp(1, 90);

    let to = chrono::Utc::now();
    let from = to - chrono::Duration::days(i64::from(days));
    let readings = crate::sheets::store::readings::between(&state.sheets, from, to).await?;

    // Bucketed at UTC+8 rather than UTC. The SQL grouped by `date_trunc('day', ...)` in
    // UTC while every screen renders at UTC+8, so each bar mixed sixteen hours of one
    // local day with eight of the previous one. Doing it here is the first chance to
    // group by the day a person would actually name.
    let mut buckets: std::collections::BTreeMap<String, Vec<&Reading>> = std::collections::BTreeMap::new();
    for reading in &readings {
        let local = reading.recorded_at + chrono::Duration::hours(8);
        buckets
            .entry(local.format("%Y-%m-%d").to_string())
            .or_default()
            .push(reading);
    }

    let points: Vec<TrendPoint> = buckets
        .into_iter()
        .map(|(day, group)| {
            let loads: Vec<f64> = group.iter().filter_map(|r| r.apparent_power_va).collect();
            let temps: Vec<f64> = group.iter().filter_map(|r| r.temperature_c).collect();
            let mean = |values: &[f64]| {
                (!values.is_empty()).then(|| values.iter().sum::<f64>() / values.len() as f64)
            };

            TrendPoint {
                // Midnight of the local day, expressed back in UTC, so the client keeps
                // receiving a timestamp rather than having to parse a label.
                day: chrono::DateTime::parse_from_rfc3339(&format!("{day}T00:00:00+08:00"))
                    .map(|parsed| parsed.with_timezone(&chrono::Utc))
                    .unwrap_or_else(|_| chrono::Utc::now()),
                avg_power_va: mean(&loads),
                // A day whose readings all lacked power leaves both null rather than
                // zero, which is the distinction migration 0011 introduced.
                max_power_va: loads.iter().copied().fold(None::<f64>, |best, value| {
                    Some(best.map_or(value, |current: f64| current.max(value)))
                }),
                avg_temperature_c: mean(&temps),
                samples: i64::try_from(group.len()).unwrap_or(i64::MAX),
            }
        })
        .collect();


    Ok(Json(points))
}

#[cfg(test)]
mod tests {
    use super::{CURRENT_RANGE, TEMPERATURE_RANGE, VOLTAGE_RANGE, in_range};

    #[test]
    fn an_absent_measurement_is_always_accepted() {
        // An ingest may carry any subset, so a board with only a probe still reports.
        assert!(in_range(None, VOLTAGE_RANGE, "voltage").is_ok());
    }

    #[test]
    fn a_plausible_measurement_is_accepted() {
        assert!(in_range(Some(230.1), VOLTAGE_RANGE, "voltage").is_ok());
        assert!(in_range(Some(0.0), CURRENT_RANGE, "current").is_ok());
        assert!(in_range(Some(-10.0), TEMPERATURE_RANGE, "temperature").is_ok());
    }

    #[test]
    fn the_pair_that_multiplied_to_infinity_is_rejected() {
        // 1e200 passed the old "not negative" check on both sides, and voltage * current
        // then overflowed to f64::INFINITY, which Postgres stored happily.
        assert!(in_range(Some(1e200), VOLTAGE_RANGE, "voltage").is_err());
        assert!(in_range(Some(1e200), CURRENT_RANGE, "current").is_err());
    }

    #[test]
    fn an_absurd_temperature_is_rejected() {
        // Previously unvalidated, so this raised a real overheat alert and pushed a
        // high-priority notification to every registered device.
        assert!(in_range(Some(999_999.0), TEMPERATURE_RANGE, "temperature").is_err());
    }

    #[test]
    fn a_negative_measurement_is_still_rejected() {
        assert!(in_range(Some(-1.0), VOLTAGE_RANGE, "voltage").is_err());
        assert!(in_range(Some(-1.0), CURRENT_RANGE, "current").is_err());
    }

    #[test]
    fn a_non_finite_measurement_is_rejected() {
        assert!(in_range(Some(f64::NAN), VOLTAGE_RANGE, "voltage").is_err());
        assert!(in_range(Some(f64::INFINITY), VOLTAGE_RANGE, "voltage").is_err());
    }
}
