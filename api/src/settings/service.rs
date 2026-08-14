use crate::error::AppResult;
use crate::settings::model::Settings;
use crate::sheets::store;
use crate::sheets::Sheets;

/// Reads the operator's thresholds.
///
/// A thin pass through to the store. Kept so callers name the domain rather than the
/// storage, which is what let the storage change underneath them.
pub async fn load(sheets: &Sheets) -> AppResult<Settings> {
    store::settings::load(sheets).await
}

pub async fn save(sheets: &Sheets, settings: &Settings) -> AppResult<Settings> {
    store::settings::save(sheets, settings).await
}

pub async fn set_source(sheets: &Sheets, mode: &str) -> AppResult<Settings> {
    store::settings::set_source(sheets, mode).await
}
