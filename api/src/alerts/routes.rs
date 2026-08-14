use axum::extract::{Path, Query, State};
use axum::routing::{get, post};
use axum::{Json, Router};
use libsql::params;
use serde::Deserialize;

use crate::alerts::model;
use crate::alerts::model::{Alert, AlertWithReading, alert_columns};
use crate::auth::extract::AuthUser;
use crate::error::{AppError, AppResult};
use crate::page::{Page, Paging};
use crate::search;
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
    let (limit, offset) = Paging::new(query.limit, query.offset).resolve(DEFAULT_LIMIT, MAX_LIMIT);
    let kind = filter(query.kind);
    let q = filter(query.q).map(|needle| search::escape_like(&needle));

    if let Some(kind) = kind.as_deref()
        && kind != model::KIND_OVERLOAD
        && kind != model::KIND_TEMPERATURE
    {
        return Err(AppError::BadRequest(format!("invalid alert kind: {kind}")));
    }

    let conn = state.db.conn()?;

    // `active` is compared against 0 rather than `false`, because SQLite stores a
    // boolean as an integer and that is what the bind arrives as.
    //
    // `like` replaces `ilike`, which SQLite lacks and does not need: its `like` is
    // already case insensitive for ASCII. The `escape` clause does have to be spelled
    // out, though. Postgres escapes with a backslash by default and SQLite has no
    // escape character at all until one is named, so without it the wildcards that
    // `search::escape_like` neutralized would be read as wildcards again.
    //
    // Counted separately so `total` covers every match, not just this window.
    let mut counted = conn
        .query(
            "select count(*) from alerts
             where (?1 = 0 or acknowledged_at is null)
               and (?2 is null or kind = ?2)
               and (?3 is null
                    or message like '%' || ?3 || '%' escape '\\'
                    or kind like '%' || ?3 || '%' escape '\\')",
            params![query.active, kind.clone(), q.clone()],
        )
        .await?;

    let total: i64 = counted
        .next()
        .await?
        .ok_or_else(|| AppError::Upstream("count returned no row".to_owned()))?
        .get(0)?;

    // Left joined, not inner: an alert whose reading has since been pruned must still
    // be listed, just without the measurements.
    let mut rows = conn
        .query(
            concat!(
                "select ",
                alert_columns!("a."),
                ", r.voltage_v, r.current_a, r.temperature_c, r.apparent_power_va,
                   r.power_w, r.power_factor, r.frequency_hz, r.energy_kwh
                 from alerts a
                 left join readings r on r.id = a.reading_id
                 where (?1 = 0 or a.acknowledged_at is null)
                   and (?2 is null or a.kind = ?2)
                   and (?3 is null
                        or a.message like '%' || ?3 || '%' escape '\\'
                        or a.kind like '%' || ?3 || '%' escape '\\')
                 order by a.created_at desc
                 limit ?4 offset ?5"
            ),
            params![query.active, kind, q, limit, offset],
        )
        .await?;

    let mut alerts = Vec::new();
    while let Some(row) = rows.next().await? {
        alerts.push(AlertWithReading::from_row(&row)?);
    }

    Ok(Json(Page::new(alerts, total, limit, offset)))
}

/// Acknowledges an alert and records how long the responder took.
async fn acknowledge(
    State(state): State<AppState>,
    auth: AuthUser,
    Path(id): Path<i64>,
) -> AppResult<Json<Alert>> {
    let conn = state.db.conn()?;

    // The response time is whole seconds on either side rather than the fractional
    // epoch Postgres reported, because `strftime('%s', ...)` is the only epoch SQLite
    // offers. Nobody acknowledges an alarm in under a second, and the app renders the
    // figure in minutes.
    //
    // `created_at` in the SET clause is the value already stored: SQLite evaluates the
    // whole expression list against the row as it was before the update.
    let mut rows = conn
        .query(
            concat!(
                "update alerts
                 set acknowledged_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now'),
                     acknowledged_by = ?1,
                     response_ms = (strftime('%s', 'now') - strftime('%s', created_at)) * 1000,
                     updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
                 where id = ?2 and acknowledged_at is null
                 returning ",
                alert_columns!("")
            ),
            params![auth.id.to_string(), id],
        )
        .await?;

    let row = rows.next().await?.ok_or(AppError::NotFound)?;

    Ok(Json(Alert::from_row(&row)?))
}
