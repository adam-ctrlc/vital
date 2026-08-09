use serde::{Deserialize, Serialize};

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RegisterToken {
    pub token: String,
    #[serde(default)]
    pub platform: Option<String>,
    /// The Android channel this device wants alerts delivered on, which is what decides
    /// the tone. Absent from older clients and from iOS.
    #[serde(default)]
    pub channel_id: Option<String>,
}

/// One message in an Expo push batch.
///
/// <https://docs.expo.dev/push-notifications/sending-notifications/>
#[derive(Debug, Serialize)]
pub struct ExpoMessage {
    pub to: String,
    pub title: String,
    pub body: String,
    /// `high` wakes the device promptly; alerts are the reason this app exists.
    pub priority: &'static str,
    pub sound: &'static str,
    /// The Android channel to deliver on, which is where the tone comes from.
    ///
    /// Omitted rather than sent empty when a device has not told us: Expo then lets
    /// Android fall back to the app's default channel, which is the old behaviour.
    #[serde(rename = "channelId", skip_serializing_if = "Option::is_none")]
    pub channel_id: Option<String>,
    /// Lets the app open straight to the alert it is about.
    pub data: serde_json::Value,
}
