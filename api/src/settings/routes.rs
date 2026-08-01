use axum::extract::State;
use axum::routing::{get, put};
use axum::{Json, Router};

use crate::auth::extract::{AdminUser, AuthUser};
use crate::error::{AppError, AppResult};
use crate::settings::model::{Settings, SettingsUpdate, SourceUpdate};
use crate::settings::service;
use crate::state::AppState;

pub fn router() -> Router<AppState> {
    Router::new()
        .route("/", get(read).put(update))
        .route("/source", put(set_source))
}

async fn read(State(state): State<AppState>, _auth: AuthUser) -> AppResult<Json<Settings>> {
    Ok(Json(service::load(&state.pool).await?))
}

async fn update(
    State(state): State<AppState>,
    _admin: AdminUser,
    Json(body): Json<SettingsUpdate>,
) -> AppResult<Json<Settings>> {
    if body.load_threshold_va <= 0.0 {
        return Err(AppError::BadRequest(
            "load threshold must be greater than zero".to_owned(),
        ));
    }
    if body.temp_threshold_c <= 0.0 {
        return Err(AppError::BadRequest(
            "temperature threshold must be greater than zero".to_owned(),
        ));
    }
    // Checked here as well as by the constraint, so the caller gets an explanation
    // rather than a bare conflict. A trip at or below the alarm would defeat the point
    // of having two: the relay would open in the same instant the alert was raised, or
    // during load the alarm is meant to permit.
    if body.trip_threshold_va <= body.load_threshold_va {
        return Err(AppError::BadRequest(
            "trip threshold must be greater than the alarm threshold".to_owned(),
        ));
    }

    let settings = sqlx::query_as::<_, Settings>(
        "update settings set load_threshold_va = $1, trip_threshold_va = $2,
                             temp_threshold_c = $3, updated_at = now()
         where id = 1
         returning load_threshold_va, trip_threshold_va, temp_threshold_c, source_mode, updated_at",
    )
    .bind(body.load_threshold_va)
    .bind(body.trip_threshold_va)
    .bind(body.temp_threshold_c)
    .fetch_one(&state.pool)
    .await?;

    Ok(Json(settings))
}

async fn set_source(
    State(state): State<AppState>,
    _admin: AdminUser,
    Json(body): Json<SourceUpdate>,
) -> AppResult<Json<Settings>> {
    match body.source_mode.as_str() {
        "simulation" | "hardware" => {}
        _ => {
            return Err(AppError::BadRequest(
                "source mode must be simulation or hardware".to_owned(),
            ));
        }
    }

    Ok(Json(service::set_source(&state.pool, &body.source_mode).await?))
}
