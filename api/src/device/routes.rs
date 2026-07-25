use axum::extract::State;
use axum::routing::{get, post};
use axum::{Json, Router};

use crate::auth::extract::{AdminUser, DeviceAuth};
use crate::device::model::{DeviceStatus, Heartbeat, HeartbeatAck};
use crate::device::service;
use crate::error::AppResult;
use crate::state::AppState;

pub fn router() -> Router<AppState> {
    Router::new()
        .route("/status", get(status))
        .route("/heartbeat", post(heartbeat))
}

/// Admin only: the payload carries the board's SSID, LAN address, firmware and uptime,
/// which is network reconnaissance rather than monitoring data. Only the Settings
/// screen renders it, and that screen is already admin-gated. The dashboard learns
/// whether the board is live from `/readings/latest` instead.
async fn status(State(state): State<AppState>, _admin: AdminUser) -> AppResult<Json<DeviceStatus>> {
    Ok(Json(service::status(&state.pool).await?))
}

/// Device only: the firmware self-reports its identity and link telemetry here, and
/// gets the current alarm thresholds back so it can adopt any operator change.
async fn heartbeat(
    State(state): State<AppState>,
    _device: DeviceAuth,
    Json(body): Json<Heartbeat>,
) -> AppResult<Json<HeartbeatAck>> {
    Ok(Json(service::record_heartbeat(&state.pool, &body).await?))
}
