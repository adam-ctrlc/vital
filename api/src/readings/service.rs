use chrono::{DateTime, Duration, Utc};
use sqlx::PgPool;

use crate::alerts;
use crate::error::{AppError, AppResult};
use crate::readings::model;
use crate::readings::model::{LiveReading, Reading, ReadingInput, Status};
use crate::readings::simulate;
use crate::readings::units;
use crate::settings::model::Settings;

#[must_use]
pub fn evaluate(input: &ReadingInput, settings: &Settings) -> (Option<f64>, Status) {
    let apparent_power_va = match (input.voltage_v, input.current_a) {
        (Some(voltage), Some(current)) => Some(voltage * current),
        _ => None,
    };
    let status = match apparent_power_va {
        Some(apparent) if apparent >= settings.load_threshold_va => Status::Overload,
        _ => Status::Normal,
    };

    (apparent_power_va, status)
}

/// Stores a measurement and opens any alerts it triggers.
///
/// Settings are taken rather than loaded, because every caller has already read them to
/// decide what to do, and reloading meant the same single row was fetched twice in one
/// request.
pub async fn record(
    pool: &PgPool,
    input: ReadingInput,
    source: &str,
    settings: &Settings,
) -> AppResult<Reading> {
    // Guarded here rather than only at the route, so every path that stores a reading
    // is covered by one rule instead of each remembering it.
    if input.is_empty() {
        return Err(AppError::BadRequest(
            "at least one measurement is required".to_owned(),
        ));
    }

    let (apparent_power_va, status) = evaluate(&input, settings);
    let reading = insert(pool, &input, apparent_power_va, status, source).await?;

    alerts::service::evaluate(pool, &reading, settings).await?;

    Ok(reading)
}

/// Generic over the executor so the same statement serves a pooled call and a call
/// inside the sampling transaction below.
async fn insert<'e, E>(
    executor: E,
    input: &ReadingInput,
    apparent_power_va: Option<f64>,
    status: Status,
    source: &str,
) -> AppResult<Reading>
where
    E: sqlx::Executor<'e, Database = sqlx::Postgres>,
{
    let reading = sqlx::query_as::<_, Reading>(
        "insert into readings
            (voltage_v, current_a, temperature_c, apparent_power_va, status, source,
             power_w, power_factor, frequency_hz, energy_kwh)
         values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
         returning id, voltage_v, current_a, temperature_c, apparent_power_va, status, source,
                   power_w, power_factor, frequency_hz, energy_kwh, recorded_at",
    )
    .bind(input.voltage_v)
    .bind(input.current_a)
    .bind(input.temperature_c)
    .bind(apparent_power_va)
    .bind(status.as_str())
    .bind(source)
    .bind(input.power_w)
    .bind(input.power_factor)
    .bind(input.frequency_hz)
    .bind(input.energy_kwh)
    .fetch_one(executor)
    .await?;

    Ok(reading)
}

/// How recently a hardware reading must have arrived for the link to count as live.
const CONNECTED_WINDOW_SECONDS: i64 = 30;

/// Whether a hardware reading recorded at `recorded_at` is recent enough to count as connected.
#[must_use]
pub fn is_within_connected_window(recorded_at: DateTime<Utc>, now: DateTime<Utc>) -> bool {
    now - recorded_at <= Duration::seconds(CONNECTED_WINDOW_SECONDS)
}

fn input_from(reading: &Reading) -> ReadingInput {
    ReadingInput {
        voltage_v: reading.voltage_v,
        current_a: reading.current_a,
        temperature_c: reading.temperature_c,
        power_w: reading.power_w,
        power_factor: reading.power_factor,
        frequency_hz: reading.frequency_hz,
        energy_kwh: reading.energy_kwh,
    }
}

/// The dashboard heartbeat.
///
/// In simulation mode the value is derived from the clock so no background task is
/// needed, and a sample is persisted only when the newest stored row is older than
/// `sample_interval_ms`, so polling fast does not flood the database. In hardware
/// mode nothing is simulated or recorded: the latest pushed reading is served, and
/// the link counts as connected only while that reading stays inside the window.
pub async fn live(pool: &PgPool, sample_interval_ms: i64) -> AppResult<LiveReading> {
    let state = load_live_state(pool).await?;
    let settings = state.settings();
    let now = Utc::now();

    let (input, recorded_at, simulated, connected) = match settings.source_mode.as_str() {
        "hardware" => match latest_hardware(pool).await? {
            // A stale or absent hardware reading reads as no data rather than the last
            // value, so the dashboard shows nothing until the board reports again.
            Some(reading) if is_within_connected_window(reading.recorded_at, now) => {
                (input_from(&reading), reading.recorded_at, false, true)
            }
            _ => (ReadingInput::empty(), now, false, false),
        },
        _ => {
            let input = simulate::at(now.timestamp_millis());

            // Cheap unlocked check first. Fourteen polls out of fifteen are not due, and
            // those should not pay for a transaction and a lock to find that out.
            if state.is_sample_due(sample_interval_ms, now) {
                if let Some(reading) =
                    record_sample(pool, &input, sample_interval_ms, &settings).await?
                {
                    // Only the request that actually wrote the row evaluates alerts, so
                    // one condition still raises one alert and one push.
                    alerts::service::evaluate(pool, &reading, &settings).await?;
                }
            }

            (input, now, true, false)
        }
    };

    let (apparent_power_va, status) = evaluate(&input, &settings);

    Ok(LiveReading {
        voltage_v: input.voltage_v,
        current_a: input.current_a,
        temperature_c: input.temperature_c,
        temperature_f: input.temperature_c.map(units::celsius_to_fahrenheit),
        apparent_power_va,
        status,
        load_threshold_va: settings.load_threshold_va,
        trip_threshold_va: settings.trip_threshold_va,
        temp_threshold_c: settings.temp_threshold_c,
        temp_threshold_f: units::celsius_to_fahrenheit(settings.temp_threshold_c),
        load_percent: apparent_power_va.map(|apparent| apparent / settings.load_threshold_va * 100.0),
        // Compared in Celsius, the unit the sensor reports and the threshold is set in.
        over_temperature: input.temperature_c.is_some_and(|t| t >= settings.temp_threshold_c),
        power_w: input.power_w,
        power_factor: input.power_factor,
        frequency_hz: input.frequency_hz,
        energy_kwh: input.energy_kwh,
        reactive_power_var: model::reactive_power(apparent_power_va, input.power_w),
        headroom_va: apparent_power_va.map(|apparent| settings.load_threshold_va - apparent),
        recorded_at,
        simulated,
        connected,
    })
}

pub async fn latest(pool: &PgPool) -> AppResult<Option<Reading>> {
    let reading = sqlx::query_as::<_, Reading>(
        "select id, voltage_v, current_a, temperature_c, apparent_power_va, status, source,
                power_w, power_factor, frequency_hz, energy_kwh, recorded_at
         from readings order by recorded_at desc limit 1",
    )
    .fetch_optional(pool)
    .await?;

    Ok(reading)
}

pub async fn latest_hardware(pool: &PgPool) -> AppResult<Option<Reading>> {
    let reading = sqlx::query_as::<_, Reading>(
        "select id, voltage_v, current_a, temperature_c, apparent_power_va, status, source,
                power_w, power_factor, frequency_hz, energy_kwh, recorded_at
         from readings where source = 'hardware' order by recorded_at desc limit 1",
    )
    .fetch_optional(pool)
    .await?;

    Ok(reading)
}

/// Namespaces the sampling lock. Arbitrary but fixed: advisory locks are keyed by this
/// number alone, so it only has to be unlikely to collide with anything else sharing
/// the database.
const SAMPLE_LOCK_KEY: i64 = 0x0056_4954_414C_01;

/// Everything the live endpoint needs before it can decide anything, in one round trip.
///
/// This is the hottest query in the system, run once a second by every open dashboard.
/// Reading the settings row and the newest simulator timestamp as separate statements
/// doubled that for no reason: one is a single row by primary key, the other a single
/// indexed lookup, and neither depends on the other.
#[derive(sqlx::FromRow)]
struct LiveState {
    load_threshold_va: f64,
    trip_threshold_va: f64,
    temp_threshold_c: f64,
    source_mode: String,
    updated_at: DateTime<Utc>,
    latest_simulator_ms: Option<i64>,
}

impl LiveState {
    fn settings(&self) -> Settings {
        Settings {
            load_threshold_va: self.load_threshold_va,
            trip_threshold_va: self.trip_threshold_va,
            temp_threshold_c: self.temp_threshold_c,
            source_mode: self.source_mode.clone(),
            updated_at: self.updated_at,
        }
    }

    fn is_sample_due(&self, sample_interval_ms: i64, now: DateTime<Utc>) -> bool {
        self.latest_simulator_ms
            .is_none_or(|ms| now.timestamp_millis() - ms >= sample_interval_ms)
    }
}

async fn load_live_state(pool: &PgPool) -> AppResult<LiveState> {
    let state = sqlx::query_as::<_, LiveState>(
        "select s.load_threshold_va, s.trip_threshold_va, s.temp_threshold_c, s.source_mode, s.updated_at,
                (select (extract(epoch from recorded_at) * 1000)::bigint
                 from readings where source = 'simulator'
                 order by recorded_at desc limit 1) as latest_simulator_ms
         from settings s
         where s.id = 1",
    )
    .fetch_one(pool)
    .await?;

    Ok(state)
}

/// Records a simulator sample, at most once per interval however many dashboards ask at
/// the same moment.
///
/// Checking and then inserting is not enough on its own: concurrent requests all read
/// "due" before any of them commits, so they all insert. That produced a row per viewer
/// instead of one per interval, skewed every average in the trend endpoint, and had each
/// duplicate evaluate alerts and push. Instances are separate processes on Vercel, so an
/// in-process guard could not help either.
///
/// A transaction scoped advisory lock elects one writer. Everyone else skips and serves
/// the same value, which is derived from the clock and therefore identical anyway. The
/// lock is released when the transaction ends, including on error, so a panicking
/// request cannot wedge sampling.
///
/// Returns the row only to the request that wrote it, so its caller alone raises alerts.
async fn record_sample(
    pool: &PgPool,
    input: &ReadingInput,
    sample_interval_ms: i64,
    settings: &Settings,
) -> AppResult<Option<Reading>> {
    let mut tx = pool.begin().await?;

    let acquired: bool = sqlx::query_scalar("select pg_try_advisory_xact_lock($1)")
        .bind(SAMPLE_LOCK_KEY)
        .fetch_one(&mut *tx)
        .await?;

    if !acquired {
        return Ok(None);
    }

    // Re-read under the lock. The request that held it a moment ago may have written
    // the very sample this one was about to duplicate.
    //
    // Scoped to the simulator feed, which the old check was not: a single hardware row
    // suppressed simulator sampling for a whole interval, and the two feeds interfered.
    let latest_ms: Option<i64> = sqlx::query_scalar(
        "select (extract(epoch from recorded_at) * 1000)::bigint
         from readings where source = 'simulator'
         order by recorded_at desc limit 1",
    )
    .fetch_optional(&mut *tx)
    .await?
    .flatten();

    let due = latest_ms.is_none_or(|ms| Utc::now().timestamp_millis() - ms >= sample_interval_ms);
    if !due {
        return Ok(None);
    }

    // Same rule as the ingest path. The simulator has never produced an empty sample,
    // but nothing guaranteed that, and a silent skip is the right answer here: no
    // caller asked for this write, so there is nobody to report a failure to.
    if input.is_empty() {
        return Ok(None);
    }

    let (apparent_power_va, status) = evaluate(input, settings);
    let reading = insert(&mut *tx, input, apparent_power_va, status, "simulator").await?;

    tx.commit().await?;

    Ok(Some(reading))
}
