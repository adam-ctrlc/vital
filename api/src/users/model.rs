use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};
use uuid::Uuid;

use crate::auth::Role;

#[derive(Debug, Clone, Serialize, sqlx::FromRow)]
#[serde(rename_all = "camelCase")]
pub struct User {
    pub id: Uuid,
    /// Absent when the account was created without one. The username is the identity
    /// the system relies on; this is contact detail.
    pub email: Option<String>,
    pub username: String,
    pub role: String,
    pub first_name: String,
    pub middle_name: Option<String>,
    pub last_name: String,
    pub full_name: String,
    pub created_at: DateTime<Utc>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CreateUser {
    /// Optional: blank or absent creates the account without one.
    #[serde(default)]
    pub email: Option<String>,
    pub password: String,
    pub role: Role,
    pub first_name: String,
    #[serde(default)]
    pub middle_name: Option<String>,
    pub last_name: String,
    /// Optional: the database generates one from the name when this is absent.
    #[serde(default)]
    pub username: Option<String>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct UpdateUser {
    /// Optional: blank or absent clears it.
    #[serde(default)]
    pub email: Option<String>,
    pub role: Role,
    pub first_name: String,
    #[serde(default)]
    pub middle_name: Option<String>,
    pub last_name: String,
    /// Optional: a blank or absent value keeps the existing username.
    #[serde(default)]
    pub username: Option<String>,
    /// Optional: a blank or absent value keeps the existing password.
    #[serde(default)]
    pub password: Option<String>,
}

/// Query for `GET /users/username-suggestion`.
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SuggestUsername {
    pub first_name: String,
    pub last_name: String,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct UsernameSuggestion {
    pub username: String,
}

/// Lowercases and strips a username to the same character set the database formula
/// uses, so a value typed in the app and one generated in SQL cannot disagree.
#[must_use]
pub fn clean_username(value: &str) -> String {
    value
        .chars()
        .filter(|c| c.is_ascii_alphanumeric())
        .collect::<String>()
        .to_lowercase()
}

/// Composes the display name the same way `full_name` is composed in SQL, so a
/// caller that only has the parts renders the identical string.
#[must_use]
pub fn full_name(first: &str, middle: Option<&str>, last: &str) -> String {
    [first, middle.unwrap_or_default(), last]
        .into_iter()
        .map(str::trim)
        .filter(|part| !part.is_empty())
        .collect::<Vec<_>>()
        .join(" ")
}

/// Trims a name part and treats blank as absent.
#[must_use]
pub fn clean_optional(value: Option<&str>) -> Option<String> {
    value
        .map(str::trim)
        .filter(|part| !part.is_empty())
        .map(ToOwned::to_owned)
}
