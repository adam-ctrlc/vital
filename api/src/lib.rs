pub mod alerts;
pub mod auth;
pub mod config;
pub mod device;
pub mod error;
pub mod notifications;
pub mod page;
pub mod readings;
pub mod search;
pub mod settings;
pub mod sheets;
pub mod state;
pub mod time;
pub mod users;

use std::sync::{Arc, Once};

use axum::Json;
use axum::Router;
use axum::routing::get;
use chrono::{DateTime, Utc};
use serde::Serialize;
use tower_http::cors::{Any, CorsLayer};
use tower_http::trace::TraceLayer;

use crate::config::Config;
use crate::error::AppResult;
use crate::sheets::Sheets;
use crate::state::AppState;

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Health {
    pub status: &'static str,
    pub checked_at: DateTime<Utc>,
    pub checked_at_label: String,
}

/// Chooses the rustls crypto provider for the process.
///
/// reqwest is built with `rustls-no-provider` so that it cannot pull in a second
/// provider alongside the `ring` that reqwest already links: two compiled in leaves
/// rustls unable to pick, which is a runtime panic rather than a build error. The
/// cost of that choice is that nothing installs a default, so this does. Without
/// it, the first outbound request panics on "no rustls crypto provider".
fn install_crypto_provider() {
    static ONCE: Once = Once::new();

    ONCE.call_once(|| {
        // Errs only if another provider won the race, which is the same outcome.
        drop(rustls::crypto::ring::default_provider().install_default());
    });
}

/// Builds the app.
///
/// There is no separate development entrypoint any more. That one existed to run
/// migrations, and a spreadsheet has no schema to migrate: a tab is created with its
/// header the first time something is written to it.
pub async fn build(config: &Config) -> AppResult<Router> {
    install_crypto_provider();

    let sheets = Sheets::new(&config.google_service_account, &config.spreadsheet_id)?;

    router(sheets, config)
}

fn router(sheets: Sheets, config: &Config) -> AppResult<Router> {
    let state = AppState {
        sheets,
        jwt_secret: Arc::from(config.jwt_secret.as_str()),
        simulator_enabled: config.simulator_enabled,
        sample_interval_ms: config.sample_interval_ms,
        device_api_key: config.device_api_key.as_deref().map(Arc::from),
    };

    let v1 = Router::new()
        .route("/health", get(health))
        .nest("/auth", auth::routes::router()?)
        .nest("/readings", readings::routes::router())
        .nest("/alerts", alerts::routes::router())
        .nest("/settings", settings::routes::router())
        .nest("/device", device::routes::router())
        .nest("/notifications", notifications::routes::router())
        .nest("/users", users::routes::router())
        .with_state(state);

    let cors = CorsLayer::new()
        .allow_origin(Any)
        .allow_methods(Any)
        .allow_headers(Any);

    Ok(Router::new()
        .nest("/api/v1", v1)
        .layer(cors)
        .layer(TraceLayer::new_for_http()))
}

async fn health() -> Json<Health> {
    let now = Utc::now();

    Json(Health {
        status: "ok",
        checked_at: now,
        checked_at_label: time::local_label(now),
    })
}
