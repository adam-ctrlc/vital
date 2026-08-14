use axum::extract::State;
use axum::routing::{get, post};
use axum::{Json, Router};

use crate::auth::extract::{AdminUser, DeviceAuth};
use crate::device::model::{DeviceStatus, Heartbeat, HeartbeatAck};
use crate::device::service;
use crate::error::{AppError, AppResult};
use crate::state::AppState;

pub fn router() -> Router<AppState> {
    Router::new()
        .route("/status", get(status))
        .route("/heartbeat", post(heartbeat))
        .route("/relay", post(relay_command))
}

/// Admin only: the payload carries the board's SSID, LAN address, firmware and uptime,
/// which is network reconnaissance rather than monitoring data. Only the Settings
/// screen renders it, and that screen is already admin-gated. The dashboard learns
/// whether the board is live from `/readings/latest` instead.
async fn status(State(state): State<AppState>, _admin: AdminUser) -> AppResult<Json<DeviceStatus>> {
    Ok(Json(service::status(&state.db.conn()?).await?))
}

/// Device only: the firmware self-reports its identity and link telemetry here, and
/// gets the current alarm thresholds back so it can adopt any operator change.
async fn heartbeat(
    State(state): State<AppState>,
    _device: DeviceAuth,
    Json(body): Json<Heartbeat>,
) -> AppResult<Json<HeartbeatAck>> {
    Ok(Json(
        service::record_heartbeat(&state.db.conn()?, &body).await?,
    ))
}

/// Admin only: asks the board to open or close the relay.
///
/// A request rather than a command, because nothing here can reach the board: it sits
/// on someone's Wi-Fi behind whatever NAT and only ever speaks outward. The command
/// waits for its next heartbeat, which is every few seconds while the relay is open.
///
/// Restricted to admins deliberately. Closing means energizing a transformer that may
/// still be faulted, and opening means cutting the load; both belong to whoever is
/// responsible for the transformer rather than to anyone holding the app.
///
/// Neither command defeats the protection. An overload re-opens the contacts three
/// seconds later no matter who closed them.
async fn relay_command(
    State(state): State<AppState>,
    admin: AdminUser,
    Json(body): Json<RelayCommand>,
) -> AppResult<Json<Accepted>> {
    if body.command != "open" && body.command != "close" {
        return Err(AppError::BadRequest(
            "relay command must be open or close".to_owned(),
        ));
    }

    service::request_relay_command(&state.db.conn()?, &body.command).await?;

    tracing::warn!(user_id = %admin.0.id, command = %body.command, "relay command queued");

    Ok(Json(Accepted { accepted: true }))
}

#[derive(serde::Deserialize)]
pub struct RelayCommand {
    pub command: String,
}

#[derive(serde::Serialize)]
pub struct Accepted {
    pub accepted: bool,
}
