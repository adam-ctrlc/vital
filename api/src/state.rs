use std::sync::Arc;

use crate::db::Db;

#[derive(Clone)]
pub struct AppState {
    /// Shared rather than cloned: `Db` holds the remote handle, and every request takes
    /// its own connection from it, which over HTTP is a handle rather than a socket.
    pub db: Arc<Db>,
    pub jwt_secret: Arc<str>,
    pub simulator_enabled: bool,
    pub sample_interval_ms: i64,
    pub device_api_key: Option<Arc<str>>,
}
