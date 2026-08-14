use std::net::SocketAddr;

use dynavolt_api::config::Config;
use dynavolt_api::error::AppResult;
use tracing_subscriber::EnvFilter;

#[tokio::main]
async fn main() -> AppResult<()> {
    dotenvy::dotenv().ok();

    tracing_subscriber::fmt()
        .with_env_filter(EnvFilter::try_from_default_env().unwrap_or_else(|_| "info".into()))
        .init();

    let config = Config::from_env()?;
    let app = dynavolt_api::build(&config).await?;

    let address = format!("0.0.0.0:{}", config.port);
    let listener = tokio::net::TcpListener::bind(&address).await?;

    tracing::info!(%address, "dynavolt api listening");

    // Connect info so the login rate limiter can key on the caller. Vercel supplies
    // `x-forwarded-for` in production; locally there is no proxy header, so without
    // this the limiter has nothing to identify the caller by.
    axum::serve(
        listener,
        app.into_make_service_with_connect_info::<SocketAddr>(),
    )
    .await?;

    Ok(())
}
