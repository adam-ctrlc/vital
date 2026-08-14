use chrono::{DateTime, Duration, Utc};
use libsql::{Connection, Row, params};

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
    conn: &Connection,
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

    // What the board reported, against what it is judged by. Kept because twice now a
    // load that raised no alert has been indistinguishable from one that was never
    // measured: the alert code only speaks when it fires, so silence covered both
    // "below the threshold" and "nothing to compare".
    //
    // Loud only when it is worth reading. An ordinary reading under the limit is the
    // overwhelming majority and says nothing, so it goes to debug; an overload, or a
    // reading with no load in it at all, goes to info where it will actually be seen.
    if status == Status::Overload || apparent_power_va.is_none() {
        tracing::info!(
            source,
            voltage_v = ?input.voltage_v,
            current_a = ?input.current_a,
            apparent_power_va = ?apparent_power_va,
            alarm_at = settings.load_threshold_va,
            ?status,
            "reading evaluated"
        );
    } else {
        tracing::debug!(source, apparent_power_va = ?apparent_power_va, "reading evaluated");
    }

    let reading = insert(conn, &input, apparent_power_va, status, source).await?;

    alerts::service::evaluate(conn, &reading, settings).await?;

    Ok(reading)
}

/// Takes the one row a statement was written to return.
///
/// An insert with a `returning` clause that produces nothing is a broken statement rather
/// than an empty result, so it is reported instead of turning into a `None` the caller
/// would have to invent a meaning for.
async fn returned_row(rows: &mut libsql::Rows, what: &str) -> AppResult<Row> {
    rows.next()
        .await?
        .ok_or_else(|| AppError::Upstream(format!("{what} returned no row")))
}

/// No longer generic over an executor.
///
/// The second caller was the sampling transaction below, which now guards itself inside a
/// single statement of its own, so a connection is the only thing left to hand over.
async fn insert(
    conn: &Connection,
    input: &ReadingInput,
    apparent_power_va: Option<f64>,
    status: Status,
    source: &str,
) -> AppResult<Reading> {
    // `recorded_at` is left to the column default, which is the strftime that writes RFC
    // 3339 with the T and the Z, so the row round trips back through chrono.
    let sql = format!(
        "insert into readings
            (voltage_v, current_a, temperature_c, apparent_power_va, status, source,
             power_w, power_factor, frequency_hz, energy_kwh, relay_closed)
         values (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11)
         returning {}",
        Reading::COLUMNS
    );

    let mut rows = conn
        .query(
            &sql,
            params![
                input.voltage_v,
                input.current_a,
                input.temperature_c,
                apparent_power_va,
                status.as_str(),
                source,
                input.power_w,
                input.power_factor,
                input.frequency_hz,
                input.energy_kwh,
                input.relay_closed,
            ],
        )
        .await?;

    let row = returned_row(&mut rows, "the reading insert").await?;

    Reading::from_row(&row)
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
        relay_closed: reading.relay_closed,
    }
}

/// The dashboard heartbeat.
///
/// In simulation mode the value is derived from the clock so no background task is
/// needed, and a sample is persisted only when the newest stored row is older than
/// `sample_interval_ms`, so polling fast does not flood the database. In hardware
/// mode nothing is simulated or recorded: the latest pushed reading is served, and
/// the link counts as connected only while that reading stays inside the window.
pub async fn live(conn: &Connection, sample_interval_ms: i64) -> AppResult<LiveReading> {
    let state = load_live_state(conn).await?;
    let settings = state.settings();
    let now = Utc::now();

    let (input, recorded_at, simulated, connected) = match settings.source_mode.as_str() {
        "hardware" => match latest_hardware(conn).await? {
            // A stale or absent hardware reading reads as no data rather than the last
            // value, so the dashboard shows nothing until the board reports again.
            Some(reading) if is_within_connected_window(reading.recorded_at, now) => {
                (input_from(&reading), reading.recorded_at, false, true)
            }
            _ => (ReadingInput::empty(), now, false, false),
        },
        _ => {
            let input = simulate::at(now.timestamp_millis());

            // Cheap check first, off the state already loaded. Fourteen polls out of
            // fifteen are not due, and those should not pay a second round trip to find
            // that out. It is only ever an early exit: the statement below decides.
            if state.is_sample_due(sample_interval_ms, now)
                && let Some(reading) =
                    record_sample(conn, &input, sample_interval_ms, &settings).await?
            {
                // Only the request that actually wrote the row evaluates alerts, so one
                // condition still raises one alert and one push.
                alerts::service::evaluate(conn, &reading, &settings).await?;
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
        load_percent: apparent_power_va
            .map(|apparent| apparent / settings.load_threshold_va * 100.0),
        // Compared in Celsius, the unit the sensor reports and the threshold is set in.
        over_temperature: input
            .temperature_c
            .is_some_and(|t| t >= settings.temp_threshold_c),
        power_w: input.power_w,
        power_factor: input.power_factor,
        frequency_hz: input.frequency_hz,
        energy_kwh: input.energy_kwh,
        reactive_power_var: model::reactive_power(apparent_power_va, input.power_w),
        headroom_va: apparent_power_va.map(|apparent| settings.load_threshold_va - apparent),
        recorded_at,
        simulated,
        connected,
        // Null outside the hardware path: nothing simulated holds a contact, and a board
        // that has gone quiet leaves an empty input rather than its last known position.
        relay_closed: input.relay_closed,
        // Only worth handing over when a real board is actually reporting: an address
        // from a board that has gone quiet would just have the app talking to nothing.
        device_ip: if connected {
            state.device_ip.clone()
        } else {
            None
        },
    })
}

/// Reads the newest reading a statement selects, if there is one.
///
/// Timestamps sort correctly as text: every one is RFC 3339, always UTC, always the same
/// width, so `order by recorded_at desc` on the stored strings is the same order it was
/// on Postgres timestamps and still rides the index.
async fn newest(conn: &Connection, sql: &str) -> AppResult<Option<Reading>> {
    let mut rows = conn.query(sql, ()).await?;

    match rows.next().await? {
        Some(row) => Reading::from_row(&row).map(Some),
        None => Ok(None),
    }
}

pub async fn latest(conn: &Connection) -> AppResult<Option<Reading>> {
    let sql = format!(
        "select {} from readings order by recorded_at desc limit 1",
        Reading::COLUMNS
    );

    newest(conn, &sql).await
}

pub async fn latest_hardware(conn: &Connection) -> AppResult<Option<Reading>> {
    let sql = format!(
        "select {} from readings where source = 'hardware' order by recorded_at desc limit 1",
        Reading::COLUMNS
    );

    newest(conn, &sql).await
}

/// Everything the live endpoint needs before it can decide anything, in one round trip.
///
/// This is the hottest query in the system, run once a second by every open dashboard.
/// Reading the settings row and the newest simulator timestamp as separate statements
/// doubled that for no reason: one is a single row by primary key, the other a single
/// indexed lookup, and neither depends on the other.
struct LiveState {
    load_threshold_va: f64,
    trip_threshold_va: f64,
    temp_threshold_c: f64,
    reclose_delay_seconds: i32,
    trip_confirm_seconds: i32,
    source_mode: String,
    updated_at: DateTime<Utc>,
    latest_simulator_ms: Option<i64>,
    device_ip: Option<String>,
}

impl LiveState {
    fn from_row(row: &Row) -> AppResult<Self> {
        Ok(Self {
            load_threshold_va: row.get(0)?,
            trip_threshold_va: row.get(1)?,
            temp_threshold_c: row.get(2)?,
            reclose_delay_seconds: row.get(3)?,
            trip_confirm_seconds: row.get(4)?,
            source_mode: row.get(5)?,
            updated_at: model::parse_timestamp(&row.get::<String>(6)?)?,
            latest_simulator_ms: row.get(7)?,
            device_ip: row.get(8)?,
        })
    }

    fn settings(&self) -> Settings {
        Settings {
            load_threshold_va: self.load_threshold_va,
            trip_threshold_va: self.trip_threshold_va,
            temp_threshold_c: self.temp_threshold_c,
            reclose_delay_seconds: self.reclose_delay_seconds,
            trip_confirm_seconds: self.trip_confirm_seconds,
            source_mode: self.source_mode.clone(),
            updated_at: self.updated_at,
        }
    }

    fn is_sample_due(&self, sample_interval_ms: i64, now: DateTime<Utc>) -> bool {
        self.latest_simulator_ms
            .is_none_or(|ms| now.timestamp_millis() - ms >= sample_interval_ms)
    }
}

async fn load_live_state(conn: &Connection) -> AppResult<LiveState> {
    // `strftime('%s', ...)` counts whole seconds, so this reads up to a second older than
    // the row really is and the sample can be judged due up to a second early. Harmless:
    // it is only the early exit, and the statement in `record_sample` decides for real.
    let mut rows = conn
        .query(
            "select s.load_threshold_va, s.trip_threshold_va, s.temp_threshold_c, s.reclose_delay_seconds,
                    s.trip_confirm_seconds, s.source_mode, s.updated_at,
                    (select strftime('%s', recorded_at) * 1000
                     from readings where source = 'simulator'
                     order by recorded_at desc limit 1) as latest_simulator_ms,
                    (select ip_address from device_telemetry where id = 1) as device_ip
             from settings s
             where s.id = 1",
            (),
        )
        .await?;

    let row = returned_row(&mut rows, "the live state query").await?;

    LiveState::from_row(&row)
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
/// Postgres elected one writer with `pg_try_advisory_xact_lock`, re-read the newest
/// sample under that lock, and inserted. SQLite has no advisory lock of any kind, so
/// there is nothing to port it to and the check and the insert are one statement instead:
/// the `where not exists` is evaluated as part of the write it guards, and SQLite admits
/// one writer at a time, so a second caller's guard sees the first caller's row and its
/// insert matches nothing.
///
/// What that changes, honestly:
///
///   * The window between the re-read and the insert is gone rather than narrowed. There
///     were two statements under the lock before; there is one now.
///   * The early exit is gone. Every due poller now sends its statement and the losers
///     write nothing, where before a failed lock turned them away without a write. The
///     cost is a statement, not a row.
///   * The guard is a timestamp comparison rather than a held lock, so it is only as
///     precise as `recorded_at`. Two samples landing inside the same millisecond would
///     both be admitted. The interval is fifteen seconds, so this is theoretical.
///
/// Still scoped to the simulator feed, which the pre-lock check was not: a single
/// hardware row used to suppress simulator sampling for a whole interval.
///
/// Returns the row only to the request that wrote it, so its caller alone raises alerts.
async fn record_sample(
    conn: &Connection,
    input: &ReadingInput,
    sample_interval_ms: i64,
    settings: &Settings,
) -> AppResult<Option<Reading>> {
    // Same rule as the ingest path. The simulator has never produced an empty sample,
    // but nothing guaranteed that, and a silent skip is the right answer here: no
    // caller asked for this write, so there is nobody to report a failure to.
    if input.is_empty() {
        return Ok(None);
    }

    // SQLite's date modifiers are strings, and this one has to carry milliseconds:
    // "-15.000 seconds" rather than "-15 seconds", so an interval that is not a whole
    // number of seconds still lands where it was configured to.
    let interval_ms = sample_interval_ms.max(0);
    let window = format!("-{}.{:03} seconds", interval_ms / 1000, interval_ms % 1000);

    let (apparent_power_va, status) = evaluate(input, settings);

    let sql = format!(
        "insert into readings
            (voltage_v, current_a, temperature_c, apparent_power_va, status, source,
             power_w, power_factor, frequency_hz, energy_kwh, relay_closed)
         select ?1, ?2, ?3, ?4, ?5, 'simulator', ?6, ?7, ?8, ?9, ?10
         where not exists (
             select 1 from readings
             where source = 'simulator'
               and recorded_at > strftime('%Y-%m-%dT%H:%M:%fZ', 'now', ?11)
         )
         returning {}",
        Reading::COLUMNS
    );

    let mut rows = conn
        .query(
            &sql,
            params![
                input.voltage_v,
                input.current_a,
                input.temperature_c,
                apparent_power_va,
                status.as_str(),
                input.power_w,
                input.power_factor,
                input.frequency_hz,
                input.energy_kwh,
                input.relay_closed,
                window,
            ],
        )
        .await?;

    // No row means the guard matched: another request wrote this interval's sample. The
    // value it wrote is derived from the clock, so it is the one this request is serving
    // anyway.
    match rows.next().await? {
        Some(row) => Reading::from_row(&row).map(Some),
        None => Ok(None),
    }
}
