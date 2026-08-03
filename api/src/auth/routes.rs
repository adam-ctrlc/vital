use std::time::Duration;

use axum::extract::State;
use axum::http::StatusCode;
use axum::response::IntoResponse;
use axum::routing::{get, post, put};
use axum::{Json, Router};
use serde::{Deserialize, Serialize};
use tower_governor::governor::GovernorConfigBuilder;
use tower_governor::key_extractor::SmartIpKeyExtractor;
use tower_governor::{GovernorError, GovernorLayer};
use uuid::Uuid;

use crate::auth::extract::AuthUser;
use crate::auth::{Role, jwt, password};
use crate::error::{AppError, AppResult};
use crate::state::AppState;
use crate::users::model::{clean_optional, clean_username};

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LoginRequest {
    /// Email or username. Accepts either so people can sign in with whichever they
    /// remember. `email` is still read for older clients.
    #[serde(alias = "email")]
    pub identifier: String,
    pub password: String,
    /// The portal the caller chose. Enforced here, not just in the app: the account's
    /// real role must match, so a user account cannot enter through the admin portal.
    #[serde(default)]
    pub role: Option<Role>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct UserResponse {
    pub id: Uuid,
    pub email: Option<String>,
    pub username: String,
    pub role: Role,
    pub first_name: String,
    pub middle_name: Option<String>,
    pub last_name: String,
    pub full_name: String,
}

impl UserResponse {
    fn from_credentials(found: Credentials, role: Role) -> Self {
        Self {
            id: found.id,
            email: found.email,
            username: found.username,
            role,
            full_name: found.full_name,
            first_name: found.first_name,
            middle_name: found.middle_name,
            last_name: found.last_name,
        }
    }
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LoginResponse {
    pub token: String,
    pub user: UserResponse,
}

#[derive(Debug, sqlx::FromRow)]
struct Credentials {
    id: Uuid,
    email: Option<String>,
    username: String,
    password_hash: String,
    role: String,
    first_name: String,
    middle_name: Option<String>,
    last_name: String,
    full_name: String,
}

/// Shared tail of every account lookup. `concat!` keeps the SQL a compile-time
/// literal, so no query is ever assembled from runtime strings.
macro_rules! credentials_select {
    ($predicate:literal) => {
        concat!(
            "select id, email, username, password_hash, role,
                    first_name, middle_name, last_name,
                    trim(concat_ws(' ', first_name, middle_name, last_name)) as full_name
             from users where ",
            $predicate
        )
    };
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct UpdateProfile {
    pub first_name: String,
    #[serde(default)]
    pub middle_name: Option<String>,
    pub last_name: String,
    #[serde(default)]
    pub email: Option<String>,
    #[serde(default)]
    pub username: Option<String>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ChangePassword {
    pub current_password: String,
    pub new_password: String,
}

/// Ten attempts up front, then one every ten seconds. Generous enough for a mistyped
/// password on a phone keyboard, tight enough that sustained guessing runs at six
/// tries a minute instead of as fast as the network allows.
const LOGIN_BURST: u32 = 10;
const LOGIN_REPLENISH_SECONDS: u64 = 10;

/// Throttles `/auth/login` by caller IP.
///
/// Scoped to this one route on purpose: the ESP32 posts a reading every ten seconds
/// and the dashboard polls once a second, so a router-wide limiter would throttle the
/// product rather than the attacker.
///
/// The honest limitation: each Vercel instance holds its own bucket, so this caps a
/// single source per instance rather than globally, and does nothing against an
/// attack spread across many addresses. It raises the cost of the easy case. The
/// airtight version is a `failed_attempts` column keyed on the account, which needs a
/// migration. The `warn` logging in `login` below is what makes either case visible.
pub fn router() -> AppResult<Router<AppState>> {
    let config = GovernorConfigBuilder::default()
        .key_extractor(SmartIpKeyExtractor)
        .period(Duration::from_secs(LOGIN_REPLENISH_SECONDS))
        .burst_size(LOGIN_BURST)
        .finish()
        .ok_or_else(|| AppError::InvalidEnv("login rate limit".to_owned()))?;

    let throttle = GovernorLayer::new(config).error_handler(|error| match error {
        // Floored at a second: governor reports the wait in whole seconds, so a caller
        // part way through the current one is told to retry in "0s", which reads as an
        // invitation to hammer the endpoint again immediately.
        GovernorError::TooManyRequests { wait_time, .. } => {
            AppError::TooManyRequests(wait_time.max(1)).into_response()
        }
        // Only reachable if neither a proxy header nor the peer address is available,
        // which means the server is wired up wrong rather than the caller misbehaving.
        other => {
            tracing::error!(?other, "login rate limiter could not identify the caller");
            AppError::Token.into_response()
        }
    });

    Ok(Router::new()
        .route("/login", post(login).layer(throttle))
        .route("/me", get(me).put(update_me))
        .route("/password", put(change_password)))
}

async fn login(
    State(state): State<AppState>,
    Json(body): Json<LoginRequest>,
) -> AppResult<Json<LoginResponse>> {
    // Email is stored lowercased and usernames are always lowercase, so one
    // lowercased needle matches either column.
    let identifier = body.identifier.trim().to_lowercase();

    let found = sqlx::query_as::<_, Credentials>(credentials_select!("email = $1 or username = $1"))
        .bind(&identifier)
        .fetch_optional(&state.pool)
        .await?;

    // When no account matches, still spend one argon2 verification against a dummy
    // hash so timing does not reveal which accounts exist.
    let Some(found) = found else {
        password::verify_dummy(&body.password);
        // Logged because a 401 is otherwise invisible: `AppError`'s response path only
        // traces 500s, so without this a guessing run leaves no trace at all in the
        // Vercel logs and cannot be detected, let alone responded to.
        tracing::warn!(%identifier, reason = "no such account", "login failed");
        return Err(AppError::InvalidCredentials);
    };

    if !password::verify(&body.password, &found.password_hash) {
        tracing::warn!(%identifier, reason = "wrong password", "login failed");
        return Err(AppError::InvalidCredentials);
    }

    let role: Role = found.role.parse()?;

    // Checked only after the password, so a wrong portal on a bad password still
    // reads "invalid credentials" and reveals neither the account nor its role.
    if let Some(chosen) = body.role
        && chosen != role
    {
        tracing::warn!(%identifier, reason = "wrong portal", "login failed");
        return Err(AppError::PortalMismatch(role));
    }

    let token = jwt::encode(&state.jwt_secret, found.id, role)?;

    Ok(Json(LoginResponse {
        token,
        user: UserResponse::from_credentials(found, role),
    }))
}

async fn me(State(state): State<AppState>, auth: AuthUser) -> AppResult<Json<UserResponse>> {
    let found = sqlx::query_as::<_, Credentials>(credentials_select!("id = $1"))
        .bind(auth.id)
        .fetch_optional(&state.pool)
        .await?
        .ok_or(AppError::NotFound)?;

    let role: Role = found.role.parse()?;

    Ok(Json(UserResponse::from_credentials(found, role)))
}

/// Resolves the email bind for a profile update. `None` leaves it unchanged. Names
/// aside, a non-admin may not change their login identity, so a differing value is
/// refused; an admin gets the trimmed lowercase form after an `@` check.
fn resolve_email(
    is_admin: bool,
    provided: Option<&str>,
    current: Option<&str>,
) -> AppResult<Option<String>> {
    let Some(raw) = provided else {
        return Ok(None);
    };
    let normalized = raw.trim().to_lowercase();

    // Blank leaves it alone rather than clearing, because the update coalesces a null
    // to the stored value anyway. It matters now that an account may legitimately have
    // no email: without this, saving the profile of one would fail the `@` check on a
    // field the owner never filled in.
    if normalized.is_empty() {
        return Ok(None);
    }

    match is_admin {
        false if normalized == current.unwrap_or_default() => Ok(None),
        false => Err(AppError::Forbidden),
        true if normalized.contains('@') => Ok(Some(normalized)),
        true => Err(AppError::BadRequest("Invalid email".to_owned())),
    }
}

/// Resolves the username bind for a profile update. `None` leaves it unchanged. A
/// non-admin may not change it, so a differing value is refused; an admin gets the
/// cleaned form and an empty result is rejected.
fn resolve_username(
    is_admin: bool,
    provided: Option<&str>,
    current: &str,
) -> AppResult<Option<String>> {
    let Some(raw) = provided else {
        return Ok(None);
    };
    let cleaned = clean_username(raw);

    match is_admin {
        false if cleaned == current => Ok(None),
        false => Err(AppError::Forbidden),
        true if cleaned.is_empty() => Err(AppError::BadRequest("Username is required".to_owned())),
        true => Ok(Some(cleaned)),
    }
}

/// Updates the caller's own profile. Names are always editable. Email and username
/// are the login identity: a standard user may not change them, but an admin may.
/// Role stays fixed here, since letting an account raise its own role would defeat
/// the point of having roles.
async fn update_me(
    State(state): State<AppState>,
    auth: AuthUser,
    Json(body): Json<UpdateProfile>,
) -> AppResult<Json<UserResponse>> {
    if body.first_name.trim().is_empty() {
        return Err(AppError::BadRequest("First name is required".to_owned()));
    }
    if body.last_name.trim().is_empty() {
        return Err(AppError::BadRequest("Last name is required".to_owned()));
    }

    let current = sqlx::query_as::<_, Credentials>(credentials_select!("id = $1"))
        .bind(auth.id)
        .fetch_optional(&state.pool)
        .await?
        .ok_or(AppError::NotFound)?;

    let is_admin = auth.role.is_admin();
    let email = resolve_email(is_admin, body.email.as_deref(), current.email.as_deref())?;
    let username = resolve_username(is_admin, body.username.as_deref(), &current.username)?;

    // RETURNING reflects the new values, so full_name is composed post-update.
    let found = sqlx::query_as::<_, Credentials>(
        "update users
         set first_name = $1, middle_name = $2, last_name = $3,
             email = coalesce($4, email), username = coalesce($5, username)
         where id = $6
         returning id, email, username, password_hash, role,
                   first_name, middle_name, last_name,
                   trim(concat_ws(' ', first_name, middle_name, last_name)) as full_name",
    )
    .bind(body.first_name.trim())
    .bind(clean_optional(body.middle_name.as_deref()))
    .bind(body.last_name.trim())
    .bind(email)
    .bind(username)
    .bind(auth.id)
    .fetch_optional(&state.pool)
    .await?
    .ok_or(AppError::NotFound)?;

    let role: Role = found.role.parse()?;

    Ok(Json(UserResponse::from_credentials(found, role)))
}

async fn change_password(
    State(state): State<AppState>,
    auth: AuthUser,
    Json(body): Json<ChangePassword>,
) -> AppResult<StatusCode> {
    if body.new_password.len() < 8 {
        return Err(AppError::BadRequest(
            "New password must be at least 8 characters".to_owned(),
        ));
    }

    let found = sqlx::query_as::<_, Credentials>(credentials_select!("id = $1"))
        .bind(auth.id)
        .fetch_optional(&state.pool)
        .await?
        .ok_or(AppError::NotFound)?;

    // Proves the person holding the token also knows the password, so a stolen
    // token cannot be used to lock the owner out.
    if !password::verify(&body.current_password, &found.password_hash) {
        return Err(AppError::InvalidCredentials);
    }

    sqlx::query("update users set password_hash = $1 where id = $2")
        .bind(password::hash(&body.new_password)?)
        .bind(auth.id)
        .execute(&state.pool)
        .await?;

    Ok(StatusCode::NO_CONTENT)
}
