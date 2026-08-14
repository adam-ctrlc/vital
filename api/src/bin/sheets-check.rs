//! Reads the spreadsheet through the real store code, to prove the seed and the parser
//! agree before anything is switched over.
//!
//! A round trip through the actual modules rather than a hand-written check: the thing
//! most likely to be wrong is a column index, and only the real parser would notice.
//!
//! Run with: cargo run --bin sheets-check

use dynavolt_api::config::Config;
use dynavolt_api::error::AppResult;
use dynavolt_api::sheets::store;
use dynavolt_api::sheets::Sheets;

#[tokio::main]
async fn main() -> AppResult<()> {
    dotenvy::dotenv().ok();

    let config = Config::from_env()?;
    let sheets = Sheets::new(&config.google_service_account, &config.spreadsheet_id)?;

    println!("tabs: {}\n", sheets.tabs().await?.join(", "));

    let settings = store::settings::load(&sheets).await?;
    println!("settings");
    println!("  alarm         {} VA", settings.load_threshold_va);
    println!("  trip          {} VA", settings.trip_threshold_va);
    println!("  temperature   {} C", settings.temp_threshold_c);
    println!("  reclose delay {} s", settings.reclose_delay_seconds);
    println!("  source        {}", settings.source_mode);

    match store::readings::latest(&sheets, None).await? {
        Some(reading) => {
            println!("\nlatest reading");
            println!("  recorded at   {}", reading.recorded_at);
            println!("  voltage       {:?}", reading.voltage_v);
            println!("  current       {:?}", reading.current_a);
            println!("  apparent      {:?}", reading.apparent_power_va);
            println!("  status        {}", reading.status);
            println!("  source        {}", reading.source);
        }
        None => println!("\nlatest reading: none found"),
    }

    // The window deliberately spans the month boundary the seed created, so a failure
    // of the rollover shows up here rather than on the first of next month.
    let to = chrono::Utc::now();
    let from = to - chrono::Duration::days(45);
    let window = store::readings::between(&sheets, from, to).await?;
    println!("\nreadings in the last 45 days: {}", window.len());

    if let (Some(first), Some(last)) = (window.first(), window.last()) {
        println!("  oldest        {}", first.recorded_at);
        println!("  newest        {}", last.recorded_at);
    }

    Ok(())
}
