use axum::extract::{Path, Query, State};
use axum::routing::{get, post};
use axum::{Json, Router};
use serde::Deserialize;

use crate::alerts::model;
use crate::alerts::model::{Alert, AlertWithReading};
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
    let (limit, offset) =
        Paging::new(query.limit, query.offset).resolve(DEFAULT_LIMIT, MAX_LIMIT);
    let kind = filter(query.kind);
    let q = filter(query.q).map(|needle| search::escape_like(&needle));

    if let Some(kind) = kind.as_deref()
        && kind != model::KIND_OVERLOAD
        && kind != model::KIND_TEMPERATURE
    {
        return Err(AppError::BadRequest(format!("invalid alert kind: {kind}")));
    }

    // Counted separately so `total` covers every match, not just this window.
    let total: i64 = sqlx::query_scalar(
        "select count(*) from alerts
         where ($1 is false or acknowledged_at is null)
           and ($2::text is null or kind = $2)
           and ($3::text is null or message ilike '%' || $3 || '%' or kind ilike '%' || $3 || '%')",
    )
    .bind(query.active)
    .bind(kind.clone())
    .bind(q.clone())
    .fetch_one(&state.pool)
    .await?;

    // Left joined, not inner: an alert whose reading has since been pruned must still
    // be listed, just without the measurements.
    let rows = sqlx::query_as::<_, AlertWithReading>(
        "select a.id, a.reading_id, a.kind, a.message, a.value, a.threshold, a.created_at,
                a.acknowledged_at, a.acknowledged_by, a.response_ms,
                r.voltage_v, r.current_a, r.temperature_c, r.apparent_power_va,
                r.power_w, r.power_factor, r.frequency_hz, r.energy_kwh
         from alerts a
         left join readings r on r.id = a.reading_id
         where ($1 is false or a.acknowledged_at is null)
           and ($2::text is null or a.kind = $2)
           and ($3::text is null or a.message ilike '%' || $3 || '%' or a.kind ilike '%' || $3 || '%')
         order by a.created_at desc
         limit $4 offset $5",
    )
    .bind(query.active)
    .bind(kind)
    .bind(q)
    .bind(limit)
    .bind(offset)
    .fetch_all(&state.pool)
    .await?;

    Ok(Json(Page::new(rows, total, limit, offset)))
}

/// Acknowledges an alert and records how long the responder took.
async fn acknowledge(
    State(state): State<AppState>,
    auth: AuthUser,
    Path(id): Path<i64>,
) -> AppResult<Json<Alert>> {
    let alert = sqlx::query_as::<_, Alert>(
        "update alerts
         set acknowledged_at = now(),
             acknowledged_by = $1,
             response_ms = (extract(epoch from (now() - created_at)) * 1000)::bigint
         where id = $2 and acknowledged_at is null
         returning id, reading_id, kind, message, value, threshold, created_at,
                   acknowledged_at, acknowledged_by, response_ms",
    )
    .bind(auth.id)
    .bind(id)
    .fetch_optional(&state.pool)
    .await?
    .ok_or(AppError::NotFound)?;

    Ok(Json(alert))
}
