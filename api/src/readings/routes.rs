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
    let reading = service::live(&state.pool, state.sample_interval_ms).await?;

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

    let settings = crate::settings::service::load(&state.pool).await?;
    let reading = service::record(&state.pool, body, "hardware", &settings).await?;

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

    // Counted separately so `total` covers every match, not just this window.
    let total: i64 = sqlx::query_scalar(
        "select count(*) from readings
         where ($1::text is null or status = $1)
           and ($2::text is null
                or status ilike '%' || $2 || '%'
                or source ilike '%' || $2 || '%'
                or round(apparent_power_va::numeric)::text ilike '%' || $2 || '%'
                or to_char(recorded_at + interval '8 hours', 'YYYY-MM-DD HH24:MI') ilike '%' || $2 || '%')
           and ($3::text is null or source = $3)",
    )
    .bind(status.clone())
    .bind(q.clone())
    .bind(source.clone())
    .fetch_one(&state.pool)
    .await?;

    // The searchable timestamp is rendered at UTC+8 so a query matches what the app shows.
    let rows = sqlx::query_as::<_, Reading>(
        "select id, voltage_v, current_a, temperature_c, apparent_power_va, status, source,
                power_w, power_factor, frequency_hz, energy_kwh, recorded_at
         from readings
         where ($1::text is null or status = $1)
           and ($2::text is null
                or status ilike '%' || $2 || '%'
                or source ilike '%' || $2 || '%'
                or round(apparent_power_va::numeric)::text ilike '%' || $2 || '%'
                or to_char(recorded_at + interval '8 hours', 'YYYY-MM-DD HH24:MI') ilike '%' || $2 || '%')
           and ($3::text is null or source = $3)
         order by recorded_at desc
         limit $4 offset $5",
    )
    .bind(status)
    .bind(q)
    .bind(source)
    .bind(limit)
    .bind(offset)
    .fetch_all(&state.pool)
    .await?;

    Ok(Json(Page::new(rows, total, limit, offset)))
}

async fn trend(
    State(state): State<AppState>,
    _admin: AdminUser,
    Query(query): Query<TrendQuery>,
) -> AppResult<Json<Vec<TrendPoint>>> {
    let days = query.days.clamp(1, 90);

    let points = sqlx::query_as::<_, TrendPoint>(
        "select date_trunc('day', recorded_at) as day,
                avg(apparent_power_va) as avg_power_va,
                max(apparent_power_va) as max_power_va,
                avg(temperature_c) as avg_temperature_c,
                count(*) as samples
         from readings
         where recorded_at >= now() - ($1 || ' days')::interval
         group by 1
         order by 1",
    )
    .bind(days.to_string())
    .fetch_all(&state.pool)
    .await?;

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
