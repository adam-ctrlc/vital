use chrono::{DateTime, Utc};
use libsql::Row;
use serde::{Deserialize, Serialize};
use uuid::Uuid;

use crate::auth::Role;
use crate::error::{AppError, AppResult};

#[derive(Debug, Clone, Serialize)]
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

/// The columns every user query selects, in the order `User::from_row` reads them.
///
/// A macro rather than a constant so `concat!` can splice it: the SQL stays a
/// compile-time literal, and no query is ever assembled from runtime strings.
///
/// `full_name` is not among them. Postgres composed it with `concat_ws` in each
/// query; here it is composed by `full_name` below, so the display name has one
/// definition instead of one in Rust and one repeated in every statement.
macro_rules! user_columns {
    () => {
        "id, email, username, role, first_name, middle_name, last_name, created_at"
    };
}

pub(crate) use user_columns;

impl User {
    /// Reads a row selected as `user_columns!()`.
    ///
    /// By index rather than by name: the column list is one macro shared by every
    /// query that builds a `User`, so the order is fixed in one place.
    pub(crate) fn from_row(row: &Row) -> AppResult<Self> {
        let first_name: String = row.get(4)?;
        let middle_name: Option<String> = row.get(5)?;
        let last_name: String = row.get(6)?;

        Ok(Self {
            id: parse_uuid(&row.get::<String>(0)?)?,
            email: row.get(1)?,
            username: row.get(2)?,
            role: row.get(3)?,
            full_name: full_name(&first_name, middle_name.as_deref(), &last_name),
            first_name,
            middle_name,
            last_name,
            created_at: parse_timestamp(&row.get::<String>(7)?)?,
        })
    }
}

/// SQLite has no uuid type, so ids are text and are parsed on the way out.
///
/// A failure here means the stored value is not a uuid at all, which is the database
/// disagreeing with itself rather than anything the caller did.
pub(crate) fn parse_uuid(value: &str) -> AppResult<Uuid> {
    Uuid::parse_str(value).map_err(|error| AppError::Upstream(format!("stored id: {error}")))
}

/// SQLite has no date type either. Timestamps are written as RFC 3339 text so they
/// sort chronologically and round trip through chrono unchanged.
pub(crate) fn parse_timestamp(value: &str) -> AppResult<DateTime<Utc>> {
    DateTime::parse_from_rfc3339(value)
        .map(|at| at.with_timezone(&Utc))
        .map_err(|error| AppError::Upstream(format!("stored timestamp: {error}")))
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
