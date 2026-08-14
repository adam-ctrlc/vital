use std::time::Duration;

use chrono::Utc;

use crate::error::{AppError, AppResult};
use crate::settings::model::Settings;
use crate::sheets::schema::{self, SETTINGS_HEADER};
use crate::sheets::Sheets;

const TAB: &str = "settings";
/// The single row, under the header.
const ROW: &str = "settings!A2:G2";

/// Settings are read on nearly every request and changed by hand a handful of times.
///
/// Ten seconds is long enough that a busy dashboard costs one read rather than dozens,
/// and short enough that an operator who edits a threshold sees it take effect while
/// still looking at the screen.
const TTL: Duration = Duration::from_secs(10);

/// Defaults for a spreadsheet that has never been written to.
///
/// Returned rather than erroring, because the alternative is an API that cannot start
/// until someone fills in a row by hand. These match the migration's defaults.
fn fallback() -> Settings {
    Settings {
        load_threshold_va: 900.0,
        trip_threshold_va: 980.0,
        temp_threshold_c: 40.0,
        reclose_delay_seconds: 30,
        source_mode: "hardware".to_owned(),
        updated_at: Utc::now(),
    }
}

fn from_row(row: &[String]) -> Settings {
    let defaults = fallback();

    Settings {
        load_threshold_va: schema::number(row, 1).unwrap_or(defaults.load_threshold_va),
        trip_threshold_va: schema::number(row, 2).unwrap_or(defaults.trip_threshold_va),
        temp_threshold_c: schema::number(row, 3).unwrap_or(defaults.temp_threshold_c),
        reclose_delay_seconds: schema::integer(row, 4)
            .and_then(|value| i32::try_from(value).ok())
            .unwrap_or(defaults.reclose_delay_seconds),
        source_mode: schema::text(row, 5).unwrap_or(defaults.source_mode),
        updated_at: schema::timestamp(row, 6).unwrap_or(defaults.updated_at),
    }
}

fn to_row(settings: &Settings) -> Vec<String> {
    vec![
        "1".to_owned(),
        settings.load_threshold_va.to_string(),
        settings.trip_threshold_va.to_string(),
        settings.temp_threshold_c.to_string(),
        settings.reclose_delay_seconds.to_string(),
        settings.source_mode.clone(),
        schema::put_time(settings.updated_at),
    ]
}

pub async fn load(sheets: &Sheets) -> AppResult<Settings> {
    let rows = sheets.values_cached(ROW, TTL).await?;

    Ok(rows.first().map_or_else(fallback, |row| from_row(row)))
}

/// Writes the whole row.
///
/// There is no partial update in a spreadsheet worth having: a per-cell write costs a
/// request each and can interleave with another writer to leave a row that is half one
/// edit and half another. One row, one call, last writer wins, which is the tradeoff
/// this design accepted.
pub async fn save(sheets: &Sheets, settings: &Settings) -> AppResult<Settings> {
    let mut next = settings.clone();
    next.updated_at = Utc::now();

    sheets.ensure_tab(TAB, SETTINGS_HEADER).await?;
    sheets.update(ROW, vec![to_row(&next)]).await?;
    sheets.invalidate(TAB).await;

    Ok(next)
}

pub async fn set_source(sheets: &Sheets, mode: &str) -> AppResult<Settings> {
    if mode != "hardware" && mode != "simulation" {
        return Err(AppError::BadRequest(format!("invalid source mode: {mode}")));
    }

    let mut settings = load(sheets).await?;
    settings.source_mode = mode.to_owned();

    save(sheets, &settings).await
}

#[cfg(test)]
mod tests {
    use super::*;

    fn row(values: &[&str]) -> Vec<String> {
        values.iter().map(|value| (*value).to_owned()).collect()
    }

    #[test]
    fn a_full_row_reads_back_as_written() {
        let original = Settings {
            load_threshold_va: 800.0,
            trip_threshold_va: 980.0,
            temp_threshold_c: 40.0,
            reclose_delay_seconds: 45,
            source_mode: "hardware".to_owned(),
            updated_at: Utc::now(),
        };

        let round_tripped = from_row(&to_row(&original));

        assert_eq!(round_tripped.load_threshold_va, 800.0);
        assert_eq!(round_tripped.trip_threshold_va, 980.0);
        assert_eq!(round_tripped.reclose_delay_seconds, 45);
        assert_eq!(round_tripped.source_mode, "hardware");
    }

    #[test]
    fn a_hand_cleared_cell_falls_back_rather_than_reading_as_zero() {
        // Somebody deleting the trip threshold in the spreadsheet must not leave the
        // board with a trip level of zero, which would open the relay on any load.
        let damaged = row(&["1", "800", "", "40", "30", "hardware", ""]);
        let settings = from_row(&damaged);

        assert_eq!(settings.trip_threshold_va, 980.0);
        assert_eq!(settings.load_threshold_va, 800.0);
    }

    #[test]
    fn an_empty_sheet_yields_usable_defaults() {
        let defaults = fallback();

        assert!(defaults.trip_threshold_va > defaults.load_threshold_va);
        assert!(defaults.reclose_delay_seconds >= 5);
    }
}
