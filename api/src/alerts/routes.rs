use std::collections::HashMap;

use axum::extract::{Path, Query, State};
use axum::routing::{get, post};
use axum::{Json, Router};
use chrono::Duration;
use serde::Deserialize;

use crate::alerts::model;
use crate::alerts::model::{Alert, AlertWithReading};
use crate::auth::extract::AuthUser;
use crate::error::{AppError, AppResult};
use crate::page::{Page, Paging};
use crate::sheets::Sheets;
use crate::sheets::schema;
use crate::sheets::store;
use crate::state::AppState;

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ListQuery {
    #[serde(default)]
    pub active: bool,
    /// Free-text search over the message and kind.
    pub q: Option<String>,
    /// Exact match on `overload` or `temperature`.
    pub kind: Option<String>,
    pub limit: Option<i64>,
    pub offset: Option<i64>,
}

const DEFAULT_LIMIT: i64 = 20;
const MAX_LIMIT: i64 = 200;

/// How far before the oldest alert on the page to start looking for readings.
///
/// A reading is written and the alert it raises follows immediately, so a window that
/// opened exactly at the alert would sit just past the row that caused it. A minute is
/// far more slack than that gap needs and costs nothing: the read is by month tab, so
/// widening within the month reads no extra rows.
const READING_LOOKBACK_MINUTES: i64 = 1;

/// How many month tabs the reading lookup is willing to fetch for one page.
///
/// Each tab is a whole month of five second samples, so this is the difference between
/// a page that renders and one that drags an archive across the wire. Two covers the
/// normal case, a page inside one month and a page straddling a rollover. A page whose
/// alerts are spread wider than that gets no measurements rather than a slow response.
const MAX_READING_TABS: usize = 2;

/// Trims a filter and treats blank as "no filter", so `?q=` behaves like an absent param.
fn filter(value: Option<String>) -> Option<String> {
    value
        .map(|raw| raw.trim().to_owned())
        .filter(|trimmed| !trimmed.is_empty())
}

pub fn router() -> Router<AppState> {
    Router::new()
        .route("/", get(list))
        .route("/{id}/ack", post(acknowledge))
}

async fn list(
    State(state): State<AppState>,
    _auth: AuthUser,
    Query(query): Query<ListQuery>,
) -> AppResult<Json<Page<AlertWithReading>>> {
    let (limit, offset) =
        Paging::new(query.limit, query.offset).resolve(DEFAULT_LIMIT, MAX_LIMIT);
    let kind = filter(query.kind);
    // Handed over raw. `search::escape_like` existed because Postgres read `%` and `_`
    // in a LIKE pattern as wildcards; the store matches with a plain substring test, so
    // escaping first would turn a search for "50%" into a search for a backslash.
    let q = filter(query.q);

    if let Some(kind) = kind.as_deref()
        && kind != model::KIND_OVERLOAD
        && kind != model::KIND_TEMPERATURE
    {
        return Err(AppError::BadRequest(format!("invalid alert kind: {kind}")));
    }

    // The filtering, the ordering, the window and the total all live in the store now:
    // a spreadsheet has no `where` or `count(*)` to push any of them into.
    let wanted = store::alerts::Filter {
        active: query.active,
        kind,
        search: q,
        limit,
        offset,
    };

    let mut page = store::alerts::list(&state.sheets, &wanted).await?;
    attach_readings(&state.sheets, &mut page.rows).await;

    Ok(Json(page))
}

/// Fills in the measurements the left join used to supply.
///
/// Only the rows being returned are looked up, never the whole table. Readings live in
/// month tabs and a tab is a quarter of a million rows, so the cost is counted in tabs
/// fetched rather than alerts resolved: one page normally sits inside one month and
/// costs one read, which the store caches for the next caller.
///
/// Every failure to resolve a reading is silent and leaves the fields `None`. That is
/// exactly the shape the left join produced for an alert whose reading had been pruned,
/// so the alert card already renders it.
async fn attach_readings(sheets: &Sheets, rows: &mut [AlertWithReading]) {
    let Some(oldest) = rows.iter().map(|row| row.created_at).min() else {
        return;
    };
    let Some(newest) = rows.iter().map(|row| row.created_at).max() else {
        return;
    };

    let from = oldest - Duration::minutes(READING_LOOKBACK_MINUTES);
    if schema::readings_tabs_between(from, newest).len() > MAX_READING_TABS {
        return;
    }

    let readings = match store::readings::between(sheets, from, newest).await {
        Ok(readings) => readings,
        Err(error) => {
            // The alerts are the answer to this request; the measurements are context on
            // the card. Losing the context must not lose the alerts.
            tracing::warn!(?error, "could not load the readings behind the listed alerts");

            return;
        }
    };

    // A reading id is a row position within its month tab, so it identifies a reading
    // only together with the month. Keyed on both, or an alert from August would pick up
    // September's row twelve.
    let by_id: HashMap<_, _> = readings
        .iter()
        .map(|reading| ((schema::readings_tab(reading.recorded_at), reading.id), reading))
        .collect();

    for row in rows {
        let Some(reading_id) = row.reading_id else {
            continue;
        };

        // The alert's own timestamp picks the tab, because it is within seconds of the
        // reading's. An alert raised in the first moments of a month by a reading
        // recorded in the last moments of the previous one looks in the wrong tab and
        // finds nothing, which costs that one card its measurements and nothing else.
        let Some(reading) = by_id.get(&(schema::readings_tab(row.created_at), reading_id)) else {
            continue;
        };

        row.voltage_v = reading.voltage_v;
        row.current_a = reading.current_a;
        row.temperature_c = reading.temperature_c;
        row.apparent_power_va = reading.apparent_power_va;
        row.power_w = reading.power_w;
        row.power_factor = reading.power_factor;
        row.frequency_hz = reading.frequency_hz;
        row.energy_kwh = reading.energy_kwh;
    }
}

/// Acknowledges an alert and records how long the responder took.
///
/// Postgres made this conditional on the alert still being open, so the second of two
/// admins pressing the button at the same moment changed nothing. A spreadsheet has no
/// conditional write, so the store reads and writes the row whole and the second press
/// overwrites the first: the responder and the response time that survive are whoever
/// arrived last. A missing alert and an already acknowledged one are both still 404.
async fn acknowledge(
    State(state): State<AppState>,
    auth: AuthUser,
    Path(id): Path<i64>,
) -> AppResult<Json<Alert>> {
    let alert = store::alerts::acknowledge(&state.sheets, id, auth.id).await?;

    Ok(Json(alert))
}
