//! Applies the schema to the remote database.
//!
//! Separate from the server on purpose. Applying it at startup would mean every
//! serverless cold start replaying fourteen statements to discover there is nothing to
//! do, and a schema change is something a person decides to make rather than something
//! that happens because a request arrived.
//!
//! Safe to run repeatedly: every statement is `if not exists`.
//!
//! Run with: cargo run --bin migrate

use dynavolt_api::config::Config;
use dynavolt_api::db;
use dynavolt_api::error::AppResult;

const SCHEMA: &str = include_str!("../../schema.sql");

#[tokio::main]
async fn main() -> AppResult<()> {
    dotenvy::dotenv().ok();

    let config = Config::from_env()?;
    let database = db::Db::connect(&config.database_url, &config.database_token).await?;
    let conn = database.conn()?;

    let applied = db::apply_schema(&conn, SCHEMA).await?;
    println!("applied {applied} statements");

    // Read back rather than trusting the count. An earlier version of this splitter
    // reported every statement applied while silently dropping two of them, because it
    // skipped chunks that began with a comment and every statement here has one.
    let mut rows = conn
        .query(
            "select name from sqlite_master
             where type in ('table', 'index') and name not like 'sqlite_%'
             order by type, name",
            (),
        )
        .await
        .map_err(|error| dynavolt_api::error::AppError::Upstream(error.to_string()))?;

    let mut names = Vec::new();
    while let Ok(Some(row)) = rows.next().await {
        if let Ok(name) = row.get::<String>(0) {
            names.push(name);
        }
    }

    println!("database now holds: {}", names.join(", "));

    Ok(())
}
