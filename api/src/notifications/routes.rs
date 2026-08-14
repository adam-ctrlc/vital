use axum::extract::State;
use axum::http::StatusCode;
use axum::routing::post;
use axum::{Json, Router};

use crate::auth::extract::AuthUser;
use crate::error::{AppError, AppResult};
use crate::notifications::model::RegisterToken;
use crate::notifications::service;
use crate::state::AppState;

pub fn router() -> Router<AppState> {
    Router::new()
        .route("/register", post(register))
        .route("/unregister", post(unregister))
}

/// Registers this device to receive alerts. Any signed-in role may: utility
/// personnel are the ones expected to respond to an overload.
async fn register(
    State(state): State<AppState>,
    auth: AuthUser,
    Json(body): Json<RegisterToken>,
) -> AppResult<StatusCode> {
    if body.token.trim().is_empty() {
        return Err(AppError::BadRequest("Push token is required".to_owned()));
    }

    service::register(&state.db.conn()?, auth.id, &body).await?;

    Ok(StatusCode::NO_CONTENT)
}

async fn unregister(
    State(state): State<AppState>,
    auth: AuthUser,
    Json(body): Json<RegisterToken>,
) -> AppResult<StatusCode> {
    service::unregister(&state.db.conn()?, &body.token, auth.id).await?;

    Ok(StatusCode::NO_CONTENT)
}
