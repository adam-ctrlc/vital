use std::time::Duration;

use axum::extract::State;
use axum::http::StatusCode;
use axum::response::IntoResponse;
use axum::routing::{get, post, put};
use axum::{Json, Router};
use libsql::{Connection, Row, params};
use serde::{Deserialize, Serialize};
use tower_governor::governor::GovernorConfigBuilder;
use tower_governor::key_extractor::SmartIpKeyExtractor;
use tower_governor::{GovernorError, GovernorLayer};
use uuid::Uuid;

use crate::auth::extract::AuthUser;
use crate::auth::{Role, jwt, password};
use crate::error::{AppError, AppResult};
use crate::state::AppState;
use crate::users::model::{CreateUser, clean_optional, clean_username, full_name, parse_uuid};
use crate::users::service as users_service;

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

#[derive(Debug)]
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
    /// `pending` until an admin approves a self-registered account.
    status: String,
}

/// The columns every account lookup selects, in the order `Credentials::from_row`
/// reads them. `full_name` is composed in Rust rather than by SQL, so the display
/// name is spelled out once instead of in every statement that returns an account.
macro_rules! credentials_columns {
    () => {
        "id, email, username, password_hash, role, first_name, middle_name, last_name, status"
    };
}

/// Shared tail of every account lookup. `concat!` keeps the SQL a compile-time
/// literal, so no query is ever assembled from runtime strings.
macro_rules! credentials_select {
    ($predicate:literal) => {
        concat!(
            "select ",
            credentials_columns!(),
            " from users where ",
            $predicate
        )
    };
}

impl Credentials {
    fn from_row(row: &Row) -> AppResult<Self> {
        let first_name: String = row.get(5)?;
        let middle_name: Option<String> = row.get(6)?;
        let last_name: String = row.get(7)?;

        Ok(Self {
            id: parse_uuid(&row.get::<String>(0)?)?,
            email: row.get(1)?,
            username: row.get(2)?,
            password_hash: row.get(3)?,
            role: row.get(4)?,
            full_name: full_name(&first_name, middle_name.as_deref(), &last_name),
            first_name,
            middle_name,
            last_name,
            status: row.get(8)?,
        })
    }
}

/// Runs an account lookup that returns at most one row.
async fn find_account(
    conn: &Connection,
    sql: &str,
    params: impl libsql::params::IntoParams,
) -> AppResult<Option<Credentials>> {
    let mut rows = conn.query(sql, params).await?;

    match rows.next().await? {
        Some(row) => Credentials::from_row(&row).map(Some),
        None => Ok(None),
    }
}

/// A sign-up from the sign-in page. Always a standard user, and pending until an admin
/// approves it, so registering grants nothing on its own.
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RegisterRequest {
    pub first_name: String,
    #[serde(default)]
    pub middle_name: Option<String>,
    pub last_name: String,
    /// Optional: generated from the name when blank.
    #[serde(default)]
    pub username: Option<String>,
    #[serde(default)]
    pub email: Option<String>,
    pub password: String,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RegisterResponse {
    /// The username the account signs in with, which may have been generated.
    pub username: String,
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

/// Sign-ups are rarer than sign-ins and each one lands in an admin's queue, so the bucket
/// is smaller: a few up front, then one a minute.
const REGISTER_BURST: u32 = 3;
const REGISTER_REPLENISH_SECONDS: u64 = 60;

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
/// A per-IP limiter for one public route. A macro because the layer's type spells out
/// the extractor, middleware and body, and only the expression needs to be written once.
macro_rules! throttle {
    ($burst:expr, $replenish_seconds:expr, $name:literal) => {{
        let config = GovernorConfigBuilder::default()
            .key_extractor(SmartIpKeyExtractor)
            .period(Duration::from_secs($replenish_seconds))
            .burst_size($burst)
            .finish()
            .ok_or_else(|| AppError::InvalidEnv(concat!($name, " rate limit").to_owned()))?;

        GovernorLayer::new(config).error_handler(|error| match error {
            // Floored at a second: governor reports the wait in whole seconds, so a caller
            // part way through the current one is told to retry in "0s", which reads as an
            // invitation to hammer the endpoint again immediately.
            GovernorError::TooManyRequests { wait_time, .. } => {
                AppError::TooManyRequests(wait_time.max(1)).into_response()
            }
            // Only reachable if neither a proxy header nor the peer address is available,
            // which means the server is wired up wrong rather than the caller misbehaving.
            other => {
                tracing::error!(
                    ?other,
                    concat!($name, " rate limiter could not identify the caller")
                );
                AppError::Token.into_response()
            }
        })
    }};
}

pub fn router() -> AppResult<Router<AppState>> {
    Ok(Router::new()
        .route(
            "/login",
            post(login).layer(throttle!(LOGIN_BURST, LOGIN_REPLENISH_SECONDS, "login")),
        )
        .route(
            "/register",
            post(register).layer(throttle!(
                REGISTER_BURST,
                REGISTER_REPLENISH_SECONDS,
                "register"
            )),
        )
        .route("/me", get(me).put(update_me))
        .route("/password", put(change_password)))
}

/// Creates a pending standard account from the sign-in page. It cannot sign in until an
/// admin approves it. The same checks as an admin-created account, minus the role, which
/// is always `user`: nobody can register themselves into admin.
async fn register(
    State(state): State<AppState>,
    Json(body): Json<RegisterRequest>,
) -> AppResult<(StatusCode, Json<RegisterResponse>)> {
    if body.first_name.trim().is_empty() {
        return Err(AppError::BadRequest("first name is required".to_owned()));
    }
    if body.last_name.trim().is_empty() {
        return Err(AppError::BadRequest("last name is required".to_owned()));
    }
    if body.password.len() < 8 {
        return Err(AppError::BadRequest(
            "password must be at least 8 characters".to_owned(),
        ));
    }
    let email = clean_optional(body.email.as_deref()).map(|value| value.to_lowercase());
    if email.as_deref().is_some_and(|value| !value.contains('@')) {
        return Err(AppError::BadRequest("invalid email".to_owned()));
    }

    let conn = state.db.conn()?;

    if let Some(email) = email.as_deref() {
        let mut taken = conn
            .query("select 1 from users where email = ?1", [email])
            .await?;
        if taken.next().await?.is_some() {
            return Err(AppError::BadRequest("email already registered".to_owned()));
        }
    }

    let username = match body.username.as_deref().map(clean_username) {
        Some(name) if !name.is_empty() => {
            let mut clash = conn
                .query("select 1 from users where username = ?1", [name.as_str()])
                .await?;
            if clash.next().await?.is_some() {
                return Err(AppError::BadRequest("username already taken".to_owned()));
            }
            name
        }
        _ => users_service::suggest_username(&conn, &body.first_name, &body.last_name).await?,
    };

    let account = CreateUser {
        email,
        password: body.password,
        role: Role::User,
        first_name: body.first_name,
        middle_name: body.middle_name,
        last_name: body.last_name,
        username: Some(username.clone()),
    };
    users_service::create(&conn, &account, "pending").await?;

    tracing::info!(%username, "account registered, awaiting approval");

    Ok((StatusCode::CREATED, Json(RegisterResponse { username })))
}

async fn login(
    State(state): State<AppState>,
    Json(body): Json<LoginRequest>,
) -> AppResult<Json<LoginResponse>> {
    // Email is stored lowercased and usernames are always lowercase, so one
    // lowercased needle matches either column.
    let identifier = body.identifier.trim().to_lowercase();

    let conn = state.db.conn()?;
    let found = find_account(
        &conn,
        credentials_select!("email = ?1 or username = ?1"),
        [identifier.as_str()],
    )
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

    // After the password, so only the account's owner learns it exists and is waiting.
    if found.status == "pending" {
        tracing::info!(%identifier, "login refused: awaiting approval");
        return Err(AppError::PendingApproval);
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
    let conn = state.db.conn()?;
    let found = find_account(&conn, credentials_select!("id = ?1"), [auth.id.to_string()])
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

    let conn = state.db.conn()?;
    let current = find_account(&conn, credentials_select!("id = ?1"), [auth.id.to_string()])
        .await?
        .ok_or(AppError::NotFound)?;

    let is_admin = auth.role.is_admin();
    let email = resolve_email(is_admin, body.email.as_deref(), current.email.as_deref())?;
    let username = resolve_username(is_admin, body.username.as_deref(), &current.username)?;

    // RETURNING reflects the new values, so full_name is composed from them.
    let found = find_account(
        &conn,
        concat!(
            "update users
             set first_name = ?1, middle_name = ?2, last_name = ?3,
                 email = coalesce(?4, email), username = coalesce(?5, username),
                 updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
             where id = ?6
             returning ",
            credentials_columns!()
        ),
        params![
            body.first_name.trim(),
            clean_optional(body.middle_name.as_deref()),
            body.last_name.trim(),
            email,
            username,
            auth.id.to_string(),
        ],
    )
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

    let conn = state.db.conn()?;
    let found = find_account(&conn, credentials_select!("id = ?1"), [auth.id.to_string()])
        .await?
        .ok_or(AppError::NotFound)?;

    // Proves the person holding the token also knows the password, so a stolen
    // token cannot be used to lock the owner out.
    if !password::verify(&body.current_password, &found.password_hash) {
        return Err(AppError::InvalidCredentials);
    }

    conn.execute(
        "update users
         set password_hash = ?1, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
         where id = ?2",
        params![password::hash(&body.new_password)?, auth.id.to_string()],
    )
    .await?;

    Ok(StatusCode::NO_CONTENT)
}
