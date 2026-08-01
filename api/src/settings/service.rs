use sqlx::PgPool;

use crate::error::AppResult;
use crate::settings::model::Settings;

pub async fn load(pool: &PgPool) -> AppResult<Settings> {
    let settings = sqlx::query_as::<_, Settings>(
        "select load_threshold_va, trip_threshold_va, temp_threshold_c, source_mode, updated_at from settings where id = 1",
    )
    .fetch_one(pool)
    .await?;

    Ok(settings)
}

pub async fn set_source(pool: &PgPool, mode: &str) -> AppResult<Settings> {
    let settings = sqlx::query_as::<_, Settings>(
        "update settings set source_mode = $1, updated_at = now()
         where id = 1
         returning load_threshold_va, trip_threshold_va, temp_threshold_c, source_mode, updated_at",
    )
    .bind(mode)
    .fetch_one(pool)
    .await?;

    Ok(settings)
}
