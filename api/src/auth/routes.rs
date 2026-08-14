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
use crate::sheets::store;
use crate::state::AppState;
use crate::users::model::{UpdateUser, User, clean_username};

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
    /// The role is taken as an argument rather than reparsed from the row, so the
    /// caller that already validated it does not have to handle the failure twice.
    fn from_user(user: User, role: Role) -> Self {
        Self {
            id: user.id,
            email: user.email,
            username: user.username,
            role,
            full_name: user.full_name,
            first_name: user.first_name,
            middle_name: user.middle_name,
            last_name: user.last_name,
        }
    }
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LoginResponse {
    pub token: String,
    pub user: UserResponse,
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
    // Lowercased for the log line below as much as for the lookup: the store matches
    // case insensitively either way, but the warnings should read the same whatever
    // case the caller typed, or the same guessing run looks like several.
    let identifier = body.identifier.trim().to_lowercase();

    let found = store::users::find_by_identifier(&state.sheets, &identifier).await?;

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

    let role: Role = found.user.role.parse()?;

    // Checked only after the password, so a wrong portal on a bad password still
    // reads "invalid credentials" and reveals neither the account nor its role.
    if let Some(chosen) = body.role
        && chosen != role
    {
        tracing::warn!(%identifier, reason = "wrong portal", "login failed");
        return Err(AppError::PortalMismatch(role));
    }

    let token = jwt::encode(&state.jwt_secret, found.user.id, role)?;

    Ok(Json(LoginResponse {
        token,
        user: UserResponse::from_user(found.user, role),
    }))
}

async fn me(State(state): State<AppState>, auth: AuthUser) -> AppResult<Json<UserResponse>> {
    let found = store::users::find_by_id(&state.sheets, auth.id)
        .await?
        .ok_or(AppError::NotFound)?;

    let role: Role = found.user.role.parse()?;

    Ok(Json(UserResponse::from_user(found.user, role)))
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

    // Read first, then write. There is no single statement that edits a row in place
    // any more, so the account is fetched to learn what the edit must preserve.
    let current = store::users::find_by_id(&state.sheets, auth.id)
        .await?
        .ok_or(AppError::NotFound)?
        .user;

    let is_admin = auth.role.is_admin();
    let email = resolve_email(is_admin, body.email.as_deref(), current.email.as_deref())?;
    let username = resolve_username(is_admin, body.username.as_deref(), &current.username)?;

    // The account's own role goes back in unchanged. The edit rewrites the whole row,
    // so omitting it would blank the cell and quietly demote whoever saved a profile.
    let role: Role = current.role.parse()?;

    // `None` from the resolvers means "leave it alone", which the SQL said with
    // `coalesce($4, email)`. The store rewrites every column, so an unchanged email has
    // to be carried across by hand or it would be cleared. A blank username needs no
    // such care: the store already keeps the stored one for an absent value.
    //
    // Between the read above and this write, another request can change the same row,
    // and the later write wins whole. Postgres settled that inside one statement.
    let edit = UpdateUser {
        email: email.or(current.email),
        role,
        first_name: body.first_name,
        middle_name: body.middle_name,
        last_name: body.last_name,
        username,
        // Absent leaves the hash alone. Changing a password is `/auth/password`, which
        // asks for the current one first.
        password: None,
    };

    // An email or username an admin moves onto another account's value now comes back
    // as a 400 from the store's own check. It used to be a 409 raised by the unique
    // index, which was also the only thing guarding this path.
    let updated = store::users::update(&state.sheets, auth.id, &edit).await?;

    Ok(Json(UserResponse::from_user(updated, role)))
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

    let found = store::users::find_by_id(&state.sheets, auth.id)
        .await?
        .ok_or(AppError::NotFound)?;

    // Proves the person holding the token also knows the password, so a stolen
    // token cannot be used to lock the owner out.
    if !password::verify(&body.current_password, &found.password_hash) {
        return Err(AppError::InvalidCredentials);
    }

    store::users::set_password(&state.sheets, auth.id, &body.new_password).await?;

    Ok(StatusCode::NO_CONTENT)
}
