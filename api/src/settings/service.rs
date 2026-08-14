use chrono::{DateTime, Utc};
use libsql::{Connection, Row, params};

use crate::error::{AppError, AppResult};
use crate::settings::model::{Settings, SettingsUpdate};

pub async fn load(conn: &Connection) -> AppResult<Settings> {
    let mut rows = conn
        .query(
            "select load_threshold_va, trip_threshold_va, temp_threshold_c, reclose_delay_seconds,
                    source_mode, updated_at
             from settings where id = 1",
            (),
        )
        .await?;

    decode(rows.next().await?)
}

/// Applies an operator's thresholds and hands back the stored row.
///
/// The row is returned rather than re-read so the response cannot describe a state that
/// a concurrent edit has already replaced.
pub async fn update(conn: &Connection, settings: &SettingsUpdate) -> AppResult<Settings> {
    let mut rows = conn
        .query(
            "update settings set load_threshold_va = ?, trip_threshold_va = ?,
                                 temp_threshold_c = ?, reclose_delay_seconds = ?,
                                 updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
             where id = 1
             returning load_threshold_va, trip_threshold_va, temp_threshold_c,
                       reclose_delay_seconds, source_mode, updated_at",
            params![
                settings.load_threshold_va,
                settings.trip_threshold_va,
                settings.temp_threshold_c,
                settings.reclose_delay_seconds,
            ],
        )
        .await?;

    decode(rows.next().await?)
}

pub async fn set_source(conn: &Connection, mode: &str) -> AppResult<Settings> {
    let mut rows = conn
        .query(
            "update settings set source_mode = ?,
                                 updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
             where id = 1
             returning load_threshold_va, trip_threshold_va, temp_threshold_c,
                       reclose_delay_seconds, source_mode, updated_at",
            params![mode],
        )
        .await?;

    decode(rows.next().await?)
}

/// Reads the row by column index, which is the only decoding this crate does.
///
/// `serde` cannot be used here: the struct is renamed to camelCase for the app, so a
/// field-name lookup would go hunting for a `loadThresholdVa` column. The order below is
/// the order every statement above selects in.
fn decode(row: Option<Row>) -> AppResult<Settings> {
    // The schema seeds id 1 and its check constraint refuses any other id, so an absent
    // row means the database is broken rather than the resource being missing. A 404 here
    // would tell the app the settings screen does not exist.
    let row = row.ok_or_else(|| AppError::Upstream("the settings row is missing".to_owned()))?;

    Ok(Settings {
        load_threshold_va: row.get(0)?,
        trip_threshold_va: row.get(1)?,
        temp_threshold_c: row.get(2)?,
        reclose_delay_seconds: row.get(3)?,
        source_mode: row.get(4)?,
        updated_at: parse_timestamp(&row.get::<String>(5)?)?,
    })
}

/// Timestamps are text in this database, so every read parses.
///
/// Strict on purpose: falling back to `Utc::now()` for an unparseable value would report
/// the moment of the read as the moment of the edit, which is a wrong answer dressed as a
/// working one.
fn parse_timestamp(raw: &str) -> AppResult<DateTime<Utc>> {
    DateTime::parse_from_rfc3339(raw)
        .map(|at| at.with_timezone(&Utc))
        .map_err(|error| AppError::Upstream(format!("unreadable timestamp {raw:?}: {error}")))
}
