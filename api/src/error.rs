use axum::Json;
use axum::http::StatusCode;
use axum::response::{IntoResponse, Response};
use serde_json::json;

#[derive(Debug, thiserror::Error)]
pub enum AppError {
    #[error("database error")]
    Database(#[from] libsql::Error),
    #[error("io error")]
    Io(#[from] std::io::Error),
    #[error("missing environment variable: {0}")]
    MissingEnv(String),
    #[error("invalid environment variable: {0}")]
    InvalidEnv(String),
    #[error("invalid credentials")]
    InvalidCredentials,
    #[error("{}", .0.portal_hint())]
    PortalMismatch(crate::auth::Role),
    #[error("missing or invalid token")]
    Unauthorized,
    #[error("admin access required")]
    Forbidden,
    #[error("not found")]
    NotFound,
    #[error("{0}")]
    BadRequest(String),
    #[error("too many attempts, try again in {0}s")]
    TooManyRequests(u64),
    #[error("could not hash password")]
    PasswordHash,
    #[error("could not create token")]
    Token,
    /// The database URL or token is wrong. A deployment problem rather than a request
    /// problem, which is why it carries what went wrong.
    #[error("configuration error: {0}")]
    Config(String),
    /// The database could not be reached, or refused. Distinct from a query failing:
    /// the fix is a network or a credential rather than the SQL.
    #[error("upstream error: {0}")]
    Upstream(String),
}

pub type AppResult<T> = Result<T, AppError>;

/// Uppercases the first character for display. `Display` stays lowercase so errors
/// compose into sentences and logs read conventionally; only the JSON the client
/// renders verbatim is sentence cased.
fn sentence_case(message: &str) -> String {
    let mut chars = message.chars();

    chars.next().map_or_else(String::new, |first| {
        first.to_uppercase().chain(chars).collect()
    })
}

/// A concurrent insert can lose the pre-check race and still hit a unique index.
/// That is the caller's conflict, not a server fault, and the alerts table leans on
/// it: the partial unique index is what stops one ongoing overload opening a second
/// alert and pushing to every phone again.
///
/// SQLite says so in two different shapes depending on where the statement ran. A
/// local connection raises `SqliteFailure` carrying the extended result code, while
/// the remote HTTP connection wraps the server's reply in a boxed error type libsql
/// does not export, so its rendered text is the only thing left to read. Both are
/// checked, because which one arrives is a property of the transport rather than of
/// the conflict.
pub(crate) fn is_unique_violation(error: &libsql::Error) -> bool {
    // SQLITE_CONSTRAINT_UNIQUE and SQLITE_CONSTRAINT_PRIMARYKEY.
    const UNIQUE_CODES: [std::ffi::c_int; 2] = [2067, 1555];
    const UNIQUE_MESSAGE: &str = "UNIQUE constraint failed";

    if let libsql::Error::SqliteFailure(code, message) = error {
        return UNIQUE_CODES.contains(code) || message.contains(UNIQUE_MESSAGE);
    }

    let rendered = error.to_string();

    rendered.contains("SQLITE_CONSTRAINT_UNIQUE")
        || rendered.contains("SQLITE_CONSTRAINT_PRIMARYKEY")
        || rendered.contains(UNIQUE_MESSAGE)
}

impl IntoResponse for AppError {
    fn into_response(self) -> Response {
        if let Self::Database(error) = &self
            && is_unique_violation(error)
        {
            let message = sentence_case("already exists");
            return (StatusCode::CONFLICT, Json(json!({ "error": message }))).into_response();
        }

        let status = match &self {
            Self::Database(_)
            | Self::Io(_)
            | Self::MissingEnv(_)
            | Self::InvalidEnv(_)
            | Self::Config(_)
            | Self::PasswordHash
            | Self::Token => StatusCode::INTERNAL_SERVER_ERROR,
            Self::InvalidCredentials | Self::PortalMismatch(_) | Self::Unauthorized => {
                StatusCode::UNAUTHORIZED
            }
            Self::Forbidden => StatusCode::FORBIDDEN,
            Self::NotFound => StatusCode::NOT_FOUND,
            Self::BadRequest(_) => StatusCode::BAD_REQUEST,
            Self::TooManyRequests(_) => StatusCode::TOO_MANY_REQUESTS,
            Self::Upstream(_) => StatusCode::BAD_GATEWAY,
        };

        if status == StatusCode::INTERNAL_SERVER_ERROR {
            tracing::error!(error = ?self, "request failed");
        }

        let message = sentence_case(&self.to_string());

        (status, Json(json!({ "error": message }))).into_response()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn sentence_case_uppercases_only_the_first_character() {
        assert_eq!(sentence_case("invalid credentials"), "Invalid credentials");
        assert_eq!(sentence_case("invalid role: nurse"), "Invalid role: nurse");
    }

    #[test]
    fn sentence_case_leaves_already_capitalised_messages_alone() {
        assert_eq!(
            sentence_case("Email already registered"),
            "Email already registered"
        );
    }

    #[test]
    fn sentence_case_handles_an_empty_message() {
        assert_eq!(sentence_case(""), "");
    }

    #[test]
    fn a_local_unique_constraint_failure_is_a_conflict() {
        let error =
            libsql::Error::SqliteFailure(2067, "UNIQUE constraint failed: alerts.kind".to_owned());

        assert!(is_unique_violation(&error));
    }

    #[test]
    fn a_remote_unique_constraint_failure_is_a_conflict() {
        // What the HTTP transport actually hands back: the server's own error, boxed
        // inside a type libsql keeps private, so only the rendered form is readable.
        let error = libsql::Error::Hrana(
            "stream error: `Error { message: \"SQLite error: UNIQUE constraint failed: \
             users.username\", code: \"SQLITE_CONSTRAINT_UNIQUE\" }`"
                .into(),
        );

        assert!(is_unique_violation(&error));
    }

    #[test]
    fn an_ordinary_database_failure_is_not_a_conflict() {
        let error = libsql::Error::SqliteFailure(1, "no such table: alerts".to_owned());

        assert!(!is_unique_violation(&error));
    }
}
