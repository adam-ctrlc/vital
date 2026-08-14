use axum::Json;
use axum::http::StatusCode;
use axum::response::{IntoResponse, Response};
use serde_json::json;

#[derive(Debug, thiserror::Error)]
pub enum AppError {
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
    /// The service account or spreadsheet is misconfigured. A deployment problem rather
    /// than a request problem, which is why it carries what went wrong.
    #[error("configuration error: {0}")]
    Config(String),
    /// Google said no, or could not be reached. Distinct from a database error because
    /// the fix is somewhere else entirely: a quota, a share, or a network.
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

impl IntoResponse for AppError {
    fn into_response(self) -> Response {
        // There is no 409 any more. It came from a unique index raising SQLSTATE 23505
        // when a concurrent insert lost the pre-check race, and a spreadsheet has no
        // such index to raise it. The stores check before writing and return a 400, so
        // a duplicate now reads as a bad request rather than a conflict, and a genuine
        // race produces two rows instead of an error.
        let status = match &self {
            Self::Io(_)
            | Self::MissingEnv(_)
            | Self::InvalidEnv(_)
            | Self::PasswordHash
            | Self::Config(_)
            | Self::Token => StatusCode::INTERNAL_SERVER_ERROR,
            Self::InvalidCredentials | Self::PortalMismatch(_) | Self::Unauthorized => {
                StatusCode::UNAUTHORIZED
            }
            Self::Forbidden => StatusCode::FORBIDDEN,
            Self::NotFound => StatusCode::NOT_FOUND,
            Self::BadRequest(_) => StatusCode::BAD_REQUEST,
            Self::TooManyRequests(_) => StatusCode::TOO_MANY_REQUESTS,
            // Not a 500. The request was fine and the store was not, and a gateway
            // status says that where a server error would send someone reading our
            // own logs for a fault that is not there.
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
