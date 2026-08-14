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
    Ok(Json(service::load(&state.sheets).await?))
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

    // Bounded here as well as by the constraint, for the same reason as the thresholds:
    // an explanation beats a conflict. Below five seconds is not a wait, and above ten
    // minutes the load is off long enough that nobody would wait for it.
    if !(5..=600).contains(&body.reclose_delay_seconds) {
        return Err(AppError::BadRequest(
            "reclose delay must be between 5 and 600 seconds".to_owned(),
        ));
    }

    // Read then written, because a spreadsheet has no partial update worth having.
    // The source mode is carried through untouched: it belongs to a different control
    // and writing the whole row would otherwise clear it.
    let mut settings = service::load(&state.sheets).await?;
    settings.load_threshold_va = body.load_threshold_va;
    settings.trip_threshold_va = body.trip_threshold_va;
    settings.temp_threshold_c = body.temp_threshold_c;
    settings.reclose_delay_seconds = body.reclose_delay_seconds;

    let settings = service::save(&state.sheets, &settings).await?;

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

    Ok(Json(service::set_source(&state.sheets, &body.source_mode).await?))
}
