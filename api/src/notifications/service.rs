use libsql::{Connection, params};
use serde_json::json;

use crate::alerts::model::Alert;
use crate::error::AppResult;
use crate::notifications::model::{ExpoMessage, RegisterToken};

const EXPO_PUSH_URL: &str = "https://exp.host/--/api/v2/push/send";
/// Expo accepts up to 100 messages per request.
const BATCH_SIZE: usize = 100;

pub async fn register(
    conn: &Connection,
    user_id: uuid::Uuid,
    body: &RegisterToken,
) -> AppResult<()> {
    conn.execute(
        "insert into push_tokens (token, user_id, platform, channel_id)
         values (?, ?, ?, ?)
         on conflict (token) do update
         set user_id = excluded.user_id,
             platform = excluded.platform,
             channel_id = excluded.channel_id",
        params![
            body.token.trim(),
            // Uuids are text here, and the hyphenated form is what every other table
            // stores, so a join keeps working.
            user_id.to_string(),
            body.platform.as_deref().unwrap_or("unknown"),
            body.channel_id
                .as_deref()
                .map(str::trim)
                .filter(|c| !c.is_empty()),
        ],
    )
    .await?;

    Ok(())
}

pub async fn unregister(conn: &Connection, token: &str, user_id: uuid::Uuid) -> AppResult<()> {
    conn.execute(
        "delete from push_tokens where token = ? and user_id = ?",
        params![token.trim(), user_id.to_string()],
    )
    .await?;

    Ok(())
}

/// Notifies every registered device about an alert.
///
/// Failures are logged, never returned: a push that does not send must not fail the
/// request that raised the alert. Recording the alert matters more than announcing it.
pub async fn notify_alert(conn: &Connection, alert: &Alert) {
    let tokens = match load_tokens(conn).await {
        Ok(tokens) => tokens,
        Err(error) => {
            tracing::error!(?error, "could not load push tokens");
            return;
        }
    };

    if tokens.is_empty() {
        return;
    }

    let title = match alert.kind.as_str() {
        "temperature" => "Transformer overheating",
        _ => "Transformer overloaded",
    };

    let messages: Vec<ExpoMessage> = tokens
        .into_iter()
        .map(|(to, channel_id)| ExpoMessage {
            to,
            title: title.to_owned(),
            body: alert.message.clone(),
            priority: "high",
            sound: "default",
            // Per device, because the tone is a per device choice.
            channel_id,
            data: json!({ "alertId": alert.id, "kind": alert.kind }),
        })
        .collect();

    let client = reqwest::Client::new();

    for batch in messages.chunks(BATCH_SIZE) {
        match client.post(EXPO_PUSH_URL).json(batch).send().await {
            Ok(response) if response.status().is_success() => {
                tracing::info!(alert_id = alert.id, devices = batch.len(), "alert pushed");
            }
            Ok(response) => {
                tracing::error!(status = %response.status(), "expo rejected the push");
            }
            Err(error) => {
                tracing::error!(?error, "could not reach expo push");
            }
        }
    }
}

/// Every registered device, with the channel it asked for.
///
/// Split out so the caller can keep failing quietly: rows arrive one await at a time
/// here, and threading that through `notify_alert` would bury the push logic in match
/// arms that all do the same thing.
async fn load_tokens(conn: &Connection) -> AppResult<Vec<(String, Option<String>)>> {
    let mut rows = conn
        .query("select token, channel_id from push_tokens", ())
        .await?;

    let mut tokens = Vec::new();

    while let Some(row) = rows.next().await? {
        tokens.push((row.get(0)?, row.get(1)?));
    }

    Ok(tokens)
}
