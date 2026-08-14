use chrono::{DateTime, Duration, Utc};

use crate::alerts;
use crate::error::{AppError, AppResult};
use crate::sheets::store;
use crate::sheets::Sheets;
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
    sheets: &Sheets,
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

    let reading = store::readings::insert(
        sheets,
        &Reading {
            // Overwritten by the store, which derives it from the row's position: a
            // spreadsheet has no sequence to ask.
            id: 0,
            voltage_v: input.voltage_v,
            current_a: input.current_a,
            temperature_c: input.temperature_c,
            apparent_power_va,
            status: status.as_str().to_owned(),
            source: source.to_owned(),
            power_w: input.power_w,
            power_factor: input.power_factor,
            frequency_hz: input.frequency_hz,
            energy_kwh: input.energy_kwh,
            relay_closed: input.relay_closed,
            recorded_at: Utc::now(),
        },
    )
    .await?;

    alerts::service::evaluate(sheets, &reading, settings).await?;

    Ok(reading)
}

/// inside the sampling transaction below.

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
pub async fn live(sheets: &Sheets, sample_interval_ms: i64) -> AppResult<LiveReading> {
    let settings = crate::settings::service::load(sheets).await?;
    let now = Utc::now();

    let (input, recorded_at, simulated, connected) = match settings.source_mode.as_str() {
        "hardware" => match store::readings::latest(sheets, Some("hardware")).await? {
            // A stale or absent hardware reading reads as no data rather than the last
            // value, so the dashboard shows nothing until the board reports again.
            Some(reading) if is_within_connected_window(reading.recorded_at, now) => {
                (input_from(&reading), reading.recorded_at, false, true)
            }
            _ => (ReadingInput::empty(), now, false, false),
        },
        _ => {
            let input = simulate::at(now.timestamp_millis());

            // The advisory lock that made this exclusive is gone, and a spreadsheet
            // offers nothing in its place. Several dashboards polling at once can now
            // each decide a sample is due and each write one, so the simulator can
            // record more often than the interval asks. Harmless for a simulated feed,
            // and the reason the interval is a floor rather than a promise.
            let due = match store::readings::latest(sheets, Some("simulator")).await? {
                Some(previous) => {
                    (now - previous.recorded_at).num_milliseconds() >= sample_interval_ms
                }
                None => true,
            };

            if due {
                let reading = record(sheets, input.clone(), "simulator", &settings).await?;
                alerts::service::evaluate(sheets, &reading, &settings).await?;
            }

            (input, now, true, false)
        }
    };

    let (apparent_power_va, status) = evaluate(&input, &settings);
    let relay_closed = input.relay_closed;

    // Only worth fetching when a board is really there. An address from one that has
    // gone quiet would have the app talking to nothing, and this is one more round trip
    // on a path the dashboard walks every second.
    let device_ip = if connected {
        store::device::load(sheets).await?.ip_address
    } else {
        None
    };

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
        // Only worth handing over when a real board is actually reporting: an address
        // from a board that has gone quiet would just have the app talking to nothing.
        device_ip: if connected { device_ip.clone() } else { None },
        relay_closed,
    })
}



