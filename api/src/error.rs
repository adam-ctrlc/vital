use axum::Json;
use axum::http::StatusCode;
use axum::response::{IntoResponse, Response};
use serde_json::json;

#[derive(Debug, thiserror::Error)]
pub enum AppError {
    #[error("database error")]
    Database(#[from] sqlx::Error),
    #[error("io error")]
    Io(#[from] std::io::Error),
    #[error("migration error")]
    Migrate(#[from] sqlx::migrate::MigrateError),
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
/// Postgres raises SQLSTATE 23505 for that, which is the caller's conflict, not a
/// server fault.
pub(crate) fn is_unique_violation(error: &sqlx::Error) -> bool {
    matches!(
        error,
        sqlx::Error::Database(db) if db.code().as_deref() == Some("23505")
    )
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
            | Self::Migrate(_)
            | Self::MissingEnv(_)
            | Self::InvalidEnv(_)
            | Self::PasswordHash
            | Self::Token => StatusCode::INTERNAL_SERVER_ERROR,
            Self::InvalidCredentials | Self::PortalMismatch(_) | Self::Unauthorized => {
                StatusCode::UNAUTHORIZED
            }
            Self::Forbidden => StatusCode::FORBIDDEN,
            Self::NotFound => StatusCode::NOT_FOUND,
            Self::BadRequest(_) => StatusCode::BAD_REQUEST,
            Self::TooManyRequests(_) => StatusCode::TOO_MANY_REQUESTS,
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
        assert_eq!(
            sentence_case("invalid role: nurse"),
            "Invalid role: nurse"
        );
    }

    #[test]
    fn sentence_case_leaves_already_capitalised_messages_alone() {
        assert_eq!(sentence_case("Email already registered"), "Email already registered");
    }

    #[test]
    fn sentence_case_handles_an_empty_message() {
        assert_eq!(sentence_case(""), "");
    }
}
