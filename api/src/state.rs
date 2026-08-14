use std::sync::Arc;

use crate::sheets::Sheets;

#[derive(Clone)]
pub struct AppState {
    /// The spreadsheet standing in for the database.
    ///
    /// Cheap to clone: it holds credentials and a cached token rather than a connection
    /// pool, because there is no connection to hold.
    pub sheets: Sheets,
    pub jwt_secret: Arc<str>,
    pub simulator_enabled: bool,
    pub sample_interval_ms: i64,
    pub device_api_key: Option<Arc<str>>,
}
