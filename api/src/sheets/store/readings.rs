use std::time::Duration;

use chrono::{DateTime, Duration as ChronoDuration, Utc};

use crate::error::AppResult;
use crate::readings::model::Reading;
use crate::sheets::schema::{self, READINGS_HEADER};
use crate::sheets::Sheets;

/// The last column of the readings header, for building ranges.
const LAST_COLUMN: char = 'M';

/// How long a whole-month read is reused when serving history.
///
/// Longer, because the logs screen is not a live view and a month is a large payload.
/// A reading written in the meantime shows up within the window.
const HISTORY_TTL: Duration = Duration::from_secs(30);

/// How many rows to pull when only the newest is wanted.
///
/// The grid height counts allocated rows rather than filled ones, so the window can
/// land past the data. Asking for a few dozen means the newest real row is inside it
/// even when the tail is mostly empty.
const TAIL_ROWS: usize = 40;

fn from_row(row: &[String]) -> Option<Reading> {
    // A row with no timestamp is not a reading. That is the header, a blank line
    // somebody left behind, or a half-written append; none should reach a caller.
    let recorded_at = schema::timestamp(row, 12)?;

    Some(Reading {
        id: schema::integer(row, 0).unwrap_or_default(),
        voltage_v: schema::number(row, 1),
        current_a: schema::number(row, 2),
        temperature_c: schema::number(row, 3),
        apparent_power_va: schema::number(row, 4),
        status: schema::text(row, 5).unwrap_or_else(|| "normal".to_owned()),
        source: schema::text(row, 6).unwrap_or_else(|| "hardware".to_owned()),
        power_w: schema::number(row, 7),
        power_factor: schema::number(row, 8),
        frequency_hz: schema::number(row, 9),
        energy_kwh: schema::number(row, 10),
        relay_closed: schema::flag(row, 11),
        recorded_at,
    })
}

fn to_row(reading: &Reading) -> Vec<String> {
    vec![
        reading.id.to_string(),
        schema::put(reading.voltage_v),
        schema::put(reading.current_a),
        schema::put(reading.temperature_c),
        schema::put(reading.apparent_power_va),
        reading.status.clone(),
        reading.source.clone(),
        schema::put(reading.power_w),
        schema::put(reading.power_factor),
        schema::put(reading.frequency_hz),
        schema::put(reading.energy_kwh),
        schema::put(reading.relay_closed),
        schema::put_time(reading.recorded_at),
    ]
}

/// Appends a reading to the tab for its month, creating that tab on the first write.
///
/// The id is the row's position rather than a sequence. Postgres owned identity and a
/// spreadsheet cannot, and the alternative, reading the whole month to find the maximum,
/// would cost a quarter of a million rows on every ingest. Position is unique within a
/// month and monotonic, which is what the id is actually used for.
///
/// It is not unique across months. Nothing joins on it except alerts, which carry the
/// timestamp too, so a collision costs nothing that is read.
pub async fn insert(sheets: &Sheets, reading: &Reading) -> AppResult<Reading> {
    let tab = schema::readings_tab(reading.recorded_at);
    sheets.ensure_tab(&tab, READINGS_HEADER).await?;

    let height = sheets.row_count(&tab).await?;
    let mut stored = reading.clone();
    stored.id = i64::try_from(height).unwrap_or(i64::MAX);

    sheets
        .append(&format!("{tab}!A1"), vec![to_row(&stored)])
        .await?;
    sheets.invalidate(&tab).await;

    Ok(stored)
}

/// The newest reading, from the current month, falling back to the previous one.
///
/// The fallback matters on the first day of a month: the new tab is empty until the
/// board reports, and without it the dashboard would read "no data" for up to the post
/// interval every month.
///
/// # This assumes the tab is in chronological order
///
/// Only the last rows are read, because scanning a quarter of a million to find the
/// newest would make the dashboard unusable. That is sound while the API is the only
/// writer, since it appends and never reorders.
///
/// It is not sound if somebody sorts the tab by hand in the browser. Doing so moves old
/// rows to the end and the dashboard will report one of them as current. The seed
/// script writes in chronological order for the same reason, and the first version of
/// it did not, which is how this was found rather than reasoned about.
pub async fn latest(sheets: &Sheets, source: Option<&str>) -> AppResult<Option<Reading>> {
    let now = Utc::now();
    let months = [
        schema::readings_tab(now),
        schema::readings_tab(now - ChronoDuration::days(1)),
    ];

    for tab in months.iter().take(if months[0] == months[1] { 1 } else { 2 }) {
        if !sheets.tabs().await?.iter().any(|existing| existing == tab) {
            continue;
        }

        let rows = sheets.tail(tab, LAST_COLUMN, TAIL_ROWS).await?;
        let newest = rows
            .iter()
            .filter_map(|row| from_row(row))
            .filter(|reading| source.is_none_or(|wanted| reading.source == wanted))
            .max_by_key(|reading| reading.recorded_at);

        if newest.is_some() {
            return Ok(newest);
        }
    }

    Ok(None)
}

/// Every reading in a window, oldest first.
///
/// Reads whole month tabs and filters here. A spreadsheet cannot answer a predicate, so
/// what was a `where` clause is now a payload: a month is a quarter of a million rows at
/// five second sampling, and this is the cost of the design.
pub async fn between(
    sheets: &Sheets,
    from: DateTime<Utc>,
    to: DateTime<Utc>,
) -> AppResult<Vec<Reading>> {
    let available = sheets.tabs().await?;
    let mut readings = Vec::new();

    for tab in schema::readings_tabs_between(from, to) {
        if !available.contains(&tab) {
            continue;
        }

        let range = format!("{tab}!A2:{LAST_COLUMN}");
        for row in sheets.values_cached(&range, HISTORY_TTL).await? {
            if let Some(reading) = from_row(&row) {
                if reading.recorded_at >= from && reading.recorded_at <= to {
                    readings.push(reading);
                }
            }
        }
    }

    readings.sort_by_key(|reading| reading.recorded_at);

    Ok(readings)
}

/// Whether a reading matches the free-text search the logs screen sends.
///
/// Kept as a function so it can be tested without a spreadsheet, and so it stays the
/// single definition of what "matching" means now that SQL no longer decides.
///
/// The timestamp is matched as rendered at UTC+8, because that is what the app displays
/// and a search that does not match what is on screen is not a search.
pub fn matches(reading: &Reading, needle: &str) -> bool {
    let needle = needle.trim().to_lowercase();
    if needle.is_empty() {
        return true;
    }

    let local = reading.recorded_at + ChronoDuration::hours(8);
    let haystack = format!(
        "{} {} {} {}",
        reading.status,
        reading.source,
        reading
            .apparent_power_va
            .map(|va| format!("{va:.0}"))
            .unwrap_or_default(),
        local.format("%Y-%m-%d %H:%M")
    );

    haystack.to_lowercase().contains(&needle)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn reading_at(recorded_at: &str, va: Option<f64>) -> Reading {
        Reading {
            id: 1,
            voltage_v: Some(230.0),
            current_a: Some(3.0),
            temperature_c: Some(31.0),
            apparent_power_va: va,
            status: "normal".to_owned(),
            source: "hardware".to_owned(),
            power_w: None,
            power_factor: None,
            frequency_hz: None,
            energy_kwh: None,
            relay_closed: Some(true),
            recorded_at: DateTime::parse_from_rfc3339(recorded_at)
                .unwrap()
                .with_timezone(&Utc),
        }
    }

    #[test]
    fn a_reading_survives_the_round_trip_through_cells() {
        let original = reading_at("2026-08-14T02:30:00Z", Some(812.5));
        let restored = from_row(&to_row(&original)).expect("a full row should parse");

        assert_eq!(restored.apparent_power_va, Some(812.5));
        assert_eq!(restored.relay_closed, Some(true));
        assert_eq!(restored.recorded_at, original.recorded_at);
    }

    #[test]
    fn a_row_without_a_timestamp_is_not_a_reading() {
        // The header, a stray blank line, or an append caught half written. None of
        // them should reach a caller as a measurement.
        let header: Vec<String> = READINGS_HEADER.iter().map(|c| (*c).to_owned()).collect();

        assert!(from_row(&header).is_none());
        assert!(from_row(&[]).is_none());
    }

    #[test]
    fn a_missing_measurement_stays_missing_rather_than_becoming_zero() {
        let mut sparse = reading_at("2026-08-14T02:30:00Z", None);
        sparse.voltage_v = None;

        let restored = from_row(&to_row(&sparse)).expect("a sparse row still parses");

        assert_eq!(restored.voltage_v, None);
        assert_eq!(restored.apparent_power_va, None);
    }

    #[test]
    fn search_matches_the_timestamp_the_app_shows_not_the_one_stored() {
        // Stored at 02:30 UTC, displayed at 10:30 in UTC+8. Someone searching for what
        // is on their screen must find it.
        let reading = reading_at("2026-08-14T02:30:00Z", Some(812.0));

        assert!(matches(&reading, "10:30"));
        assert!(!matches(&reading, "02:30"));
    }

    #[test]
    fn search_matches_status_source_and_a_rounded_load() {
        let reading = reading_at("2026-08-14T02:30:00Z", Some(812.4));

        assert!(matches(&reading, "normal"));
        assert!(matches(&reading, "hardware"));
        assert!(matches(&reading, "812"));
        assert!(!matches(&reading, "overload"));
    }

    #[test]
    fn an_empty_search_matches_everything() {
        let reading = reading_at("2026-08-14T02:30:00Z", None);

        assert!(matches(&reading, ""));
        assert!(matches(&reading, "   "));
    }
}
