use chrono::{DateTime, Datelike, Utc};

/// Every cell arrives as a string, so each read is a parse that can fail.
///
/// It fails to `None` rather than an error throughout. A spreadsheet is editable by
/// hand, and someone typing a word into a number column should cost that one field,
/// not the whole request. Callers already treat every measurement as optional, so a
/// junk cell lands in the same place a missing sensor does.
pub fn cell(row: &[String], index: usize) -> Option<&str> {
    // Sheets truncates trailing empty cells rather than padding, so a short row is
    // normal rather than a sign of corruption.
    row.get(index).map(String::as_str).filter(|value| !value.is_empty())
}

pub fn text(row: &[String], index: usize) -> Option<String> {
    cell(row, index).map(ToOwned::to_owned)
}

pub fn number(row: &[String], index: usize) -> Option<f64> {
    cell(row, index)?.parse().ok()
}

pub fn integer(row: &[String], index: usize) -> Option<i64> {
    cell(row, index)?.parse().ok()
}

pub fn flag(row: &[String], index: usize) -> Option<bool> {
    match cell(row, index)?.to_ascii_lowercase().as_str() {
        "true" | "t" | "1" | "yes" => Some(true),
        "false" | "f" | "0" | "no" => Some(false),
        _ => None,
    }
}

pub fn timestamp(row: &[String], index: usize) -> Option<DateTime<Utc>> {
    let raw = cell(row, index)?;

    DateTime::parse_from_rfc3339(raw)
        .ok()
        .map(|parsed| parsed.with_timezone(&Utc))
}

/// Renders a value for a cell, with absence as the empty string.
///
/// Not "null" or "NULL": those are words a spreadsheet shows literally, and a column of
/// them is harder to read than a column of blanks. Empty round-trips back to `None`.
pub fn put<T: ToString>(value: Option<T>) -> String {
    value.map(|inner| inner.to_string()).unwrap_or_default()
}

pub fn put_time(value: DateTime<Utc>) -> String {
    value.to_rfc3339()
}

/// The tab a reading belongs in, by month.
///
/// Monthly rollover, because ten million cells is about forty days of five second
/// samples and a single tab would simply stop accepting writes. Splitting by month
/// keeps every row and makes the boundary predictable rather than arriving as a
/// failure one afternoon.
pub fn readings_tab(at: DateTime<Utc>) -> String {
    format!("readings-{:04}-{:02}", at.year(), at.month())
}

/// The month tabs a range touches, oldest first.
///
/// A query spanning a boundary has to read both, which is the cost of the rollover.
pub fn readings_tabs_between(from: DateTime<Utc>, to: DateTime<Utc>) -> Vec<String> {
    let mut tabs = Vec::new();
    let (mut year, mut month) = (from.year(), from.month());

    loop {
        tabs.push(format!("readings-{year:04}-{month:02}"));

        if (year, month) >= (to.year(), to.month()) {
            break;
        }

        if month == 12 {
            year += 1;
            month = 1;
        } else {
            month += 1;
        }
    }

    tabs
}

pub const READINGS_HEADER: &[&str] = &[
    "id",
    "voltage_v",
    "current_a",
    "temperature_c",
    "apparent_power_va",
    "status",
    "source",
    "power_w",
    "power_factor",
    "frequency_hz",
    "energy_kwh",
    "relay_closed",
    "recorded_at",
];

pub const ALERTS_HEADER: &[&str] = &[
    "id",
    "reading_id",
    "kind",
    "message",
    "value",
    "threshold",
    "created_at",
    "acknowledged_at",
    "acknowledged_by",
    "response_ms",
    "last_notified_at",
];

pub const USERS_HEADER: &[&str] = &[
    "id",
    "email",
    "username",
    "password_hash",
    "role",
    "first_name",
    "middle_name",
    "last_name",
    "created_at",
    "updated_at",
];

pub const SETTINGS_HEADER: &[&str] = &[
    "id",
    "load_threshold_va",
    "trip_threshold_va",
    "temp_threshold_c",
    "reclose_delay_seconds",
    "source_mode",
    "updated_at",
];

pub const DEVICE_HEADER: &[&str] = &[
    "id",
    "device_id",
    "firmware",
    "ssid",
    "ip_address",
    "signal_dbm",
    "uptime_seconds",
    "relay_command",
    "relay_locked_out",
    "reported_at",
];

pub const PUSH_TOKENS_HEADER: &[&str] = &["token", "user_id", "platform", "channel_id", "created_at"];

#[cfg(test)]
mod tests {
    use super::*;

    fn row(values: &[&str]) -> Vec<String> {
        values.iter().map(|value| (*value).to_owned()).collect()
    }

    #[test]
    fn a_short_row_reads_as_missing_rather_than_panicking() {
        let short = row(&["1", "230.1"]);

        assert_eq!(number(&short, 1), Some(230.1));
        assert_eq!(number(&short, 9), None);
    }

    #[test]
    fn a_blank_cell_is_absence_not_zero() {
        let blank = row(&["1", "", "3"]);

        assert_eq!(number(&blank, 1), None);
        assert_eq!(number(&blank, 2), Some(3.0));
    }

    #[test]
    fn nonsense_in_a_number_column_costs_that_field_alone() {
        let typo = row(&["1", "two hundred", "3"]);

        assert_eq!(number(&typo, 1), None);
        assert_eq!(number(&typo, 2), Some(3.0));
    }

    #[test]
    fn a_month_maps_to_its_own_tab() {
        let january = DateTime::parse_from_rfc3339("2026-01-09T10:00:00Z")
            .unwrap()
            .with_timezone(&Utc);

        assert_eq!(readings_tab(january), "readings-2026-01");
    }

    #[test]
    fn a_range_crossing_a_year_lists_every_month_in_order() {
        let from = DateTime::parse_from_rfc3339("2026-11-20T00:00:00Z")
            .unwrap()
            .with_timezone(&Utc);
        let to = DateTime::parse_from_rfc3339("2027-02-03T00:00:00Z")
            .unwrap()
            .with_timezone(&Utc);

        assert_eq!(
            readings_tabs_between(from, to),
            vec![
                "readings-2026-11",
                "readings-2026-12",
                "readings-2027-01",
                "readings-2027-02"
            ]
        );
    }

    #[test]
    fn a_flag_accepts_what_a_spreadsheet_actually_writes() {
        assert_eq!(flag(&row(&["TRUE"]), 0), Some(true));
        assert_eq!(flag(&row(&["false"]), 0), Some(false));
        assert_eq!(flag(&row(&[""]), 0), None);
    }
}
