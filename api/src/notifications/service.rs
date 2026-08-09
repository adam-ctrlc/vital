use serde_json::json;
use sqlx::PgPool;

use crate::alerts::model::Alert;
use crate::error::AppResult;
use crate::notifications::model::{ExpoMessage, RegisterToken};

const EXPO_PUSH_URL: &str = "https://exp.host/--/api/v2/push/send";
/// Expo accepts up to 100 messages per request.
const BATCH_SIZE: usize = 100;

pub async fn register(pool: &PgPool, user_id: uuid::Uuid, body: &RegisterToken) -> AppResult<()> {
    sqlx::query(
        "insert into push_tokens (token, user_id, platform, channel_id)
         values ($1, $2, $3, $4)
         on conflict (token) do update
         set user_id = excluded.user_id,
             platform = excluded.platform,
             channel_id = excluded.channel_id",
    )
    .bind(body.token.trim())
    .bind(user_id)
    .bind(body.platform.as_deref().unwrap_or("unknown"))
    .bind(body.channel_id.as_deref().map(str::trim).filter(|c| !c.is_empty()))
    .execute(pool)
    .await?;

    Ok(())
}

pub async fn unregister(pool: &PgPool, token: &str, user_id: uuid::Uuid) -> AppResult<()> {
    sqlx::query("delete from push_tokens where token = $1 and user_id = $2")
        .bind(token.trim())
        .bind(user_id)
        .execute(pool)
        .await?;

    Ok(())
}

/// Notifies every registered device about an alert.
///
/// Failures are logged, never returned: a push that does not send must not fail the
/// request that raised the alert. Recording the alert matters more than announcing it.
pub async fn notify_alert(pool: &PgPool, alert: &Alert) {
    let tokens: Vec<(String, Option<String>)> = match sqlx::query_as(
        "select token, channel_id from push_tokens",
    )
    .fetch_all(pool)
    .await
    {
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
