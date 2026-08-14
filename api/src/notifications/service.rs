use serde_json::json;

use crate::alerts::model::Alert;
use crate::error::AppResult;
use crate::notifications::model::{ExpoMessage, RegisterToken};
use crate::sheets::store;
use crate::sheets::Sheets;

const EXPO_PUSH_URL: &str = "https://exp.host/--/api/v2/push/send";
/// Expo accepts up to 100 messages per request.
const BATCH_SIZE: usize = 100;

pub async fn register(sheets: &Sheets, user_id: uuid::Uuid, body: &RegisterToken) -> AppResult<()> {
    store::push::register(sheets, user_id, body).await
}

pub async fn unregister(sheets: &Sheets, token: &str, user_id: uuid::Uuid) -> AppResult<()> {
    store::push::unregister(sheets, token, user_id).await
}

/// Notifies every registered device about an alert.
///
/// Failures are logged, never returned: a push that does not send must not fail the
/// request that raised the alert. Recording the alert matters more than announcing it.
pub async fn notify_alert(sheets: &Sheets, alert: &Alert) {
    let tokens = match store::push::all(sheets).await {
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

    // One message per stored row rather than per device. The unique index on the token is
    // gone with Postgres, so a token that raced two registrations sits on two rows and
    // that phone is told twice about the same alert.
    let messages: Vec<ExpoMessage> = tokens
        .into_iter()
        .map(|entry| ExpoMessage {
            to: entry.token,
            title: title.to_owned(),
            body: alert.message.clone(),
            priority: "high",
            sound: "default",
            // Per device, because the tone is a per device choice.
            channel_id: entry.channel_id,
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
