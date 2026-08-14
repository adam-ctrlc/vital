use axum::extract::{Path, Query, State};
use axum::http::StatusCode;
use axum::routing::get;
use axum::{Json, Router};
use libsql::params;
use serde::Deserialize;
use uuid::Uuid;

use crate::auth::Role;
use crate::auth::extract::AdminUser;
use crate::error::{AppError, AppResult};
use crate::search;
use crate::state::AppState;
use crate::users::model::{
    CreateUser, SuggestUsername, UpdateUser, User, UsernameSuggestion, clean_optional,
    clean_username, user_columns,
};
use crate::users::service;

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ListQuery {
    /// Free-text search over the name parts, email and username.
    pub q: Option<String>,
    /// Exact match on `admin` or `user`.
    pub role: Option<String>,
}

/// Trims a filter and treats blank as "no filter".
fn filter(value: Option<String>) -> Option<String> {
    value
        .map(|raw| raw.trim().to_owned())
        .filter(|trimmed| !trimmed.is_empty())
}

pub fn router() -> Router<AppState> {
    Router::new()
        .route("/", get(list).post(create))
        .route("/username-suggestion", get(username_suggestion))
        .route("/{id}", axum::routing::delete(remove).put(update))
}

async fn list(
    State(state): State<AppState>,
    _admin: AdminUser,
    Query(query): Query<ListQuery>,
) -> AppResult<Json<Vec<User>>> {
    let role = filter(query.role);

    if let Some(role) = role.as_deref()
        && role != "admin"
        && role != "user"
    {
        return Err(AppError::BadRequest(format!("invalid role: {role}")));
    }

    let conn = state.db.conn()?;

    // `like` rather than `ilike`, which SQLite does not have and does not need: its
    // `like` is already case insensitive for ASCII, so the behavior is unchanged.
    //
    // The `escape` clause is not optional here. Postgres treats a backslash as the
    // escape character by default, SQLite has none until one is named, so without it
    // the wildcards `search::escape_like` neutralized would be matched literally and a
    // needle containing `%` would find nothing at all.
    let mut rows = conn
        .query(
            concat!(
                "select ",
                user_columns!(),
                " from users
                 where (?1 is null or role = ?1)
                   and (?2 is null
                        or email like '%' || ?2 || '%' escape '\\'
                        or username like '%' || ?2 || '%' escape '\\'
                        or first_name like '%' || ?2 || '%' escape '\\'
                        or middle_name like '%' || ?2 || '%' escape '\\'
                        or last_name like '%' || ?2 || '%' escape '\\'
                        or trim(first_name || ' ' || coalesce(middle_name || ' ', '') || last_name)
                           like '%' || ?2 || '%' escape '\\')
                 order by created_at"
            ),
            params![
                role,
                filter(query.q).map(|needle| search::escape_like(&needle))
            ],
        )
        .await?;

    let mut users = Vec::new();
    while let Some(row) = rows.next().await? {
        users.push(User::from_row(&row)?);
    }

    Ok(Json(users))
}

/// Backs the "Generate" button on the add-account form.
async fn username_suggestion(
    State(state): State<AppState>,
    _admin: AdminUser,
    Query(query): Query<SuggestUsername>,
) -> AppResult<Json<UsernameSuggestion>> {
    let conn = state.db.conn()?;
    let username = service::suggest_username(&conn, &query.first_name, &query.last_name).await?;

    Ok(Json(UsernameSuggestion { username }))
}

async fn create(
    State(state): State<AppState>,
    _admin: AdminUser,
    Json(body): Json<CreateUser>,
) -> AppResult<StatusCode> {
    if body.password.len() < 8 {
        return Err(AppError::BadRequest(
            "password must be at least 8 characters".to_owned(),
        ));
    }
    // Only checked when one was given. Blank means the account simply has no email,
    // which the username covers: it is generated from the name and is what signs in.
    let email = clean_optional(body.email.as_deref()).map(|value| value.to_lowercase());
    if email.as_deref().is_some_and(|value| !value.contains('@')) {
        return Err(AppError::BadRequest("invalid email".to_owned()));
    }
    if body.first_name.trim().is_empty() {
        return Err(AppError::BadRequest("first name is required".to_owned()));
    }
    if body.last_name.trim().is_empty() {
        return Err(AppError::BadRequest("last name is required".to_owned()));
    }

    let conn = state.db.conn()?;

    let mut taken = conn
        .query("select id from users where email = ?1", params![email])
        .await?;

    if taken.next().await?.is_some() {
        return Err(AppError::BadRequest("email already registered".to_owned()));
    }

    // Only a username the admin typed is checked here; a blank one is generated in
    // the service, and the formula only ever returns a free name.
    if let Some(username) = body.username.as_deref().map(clean_username)
        && !username.is_empty()
    {
        let mut clash = conn
            .query("select id from users where username = ?1", [username])
            .await?;

        if clash.next().await?.is_some() {
            return Err(AppError::BadRequest("username already taken".to_owned()));
        }
    }

    service::create(&conn, &body).await?;

    Ok(StatusCode::CREATED)
}

async fn update(
    State(state): State<AppState>,
    admin: AdminUser,
    Path(id): Path<Uuid>,
    Json(body): Json<UpdateUser>,
) -> AppResult<Json<User>> {
    // Blank clears it, so an account created without an email can stay that way and
    // one that has it can have it removed.
    if clean_optional(body.email.as_deref()).is_some_and(|value| !value.contains('@')) {
        return Err(AppError::BadRequest("invalid email".to_owned()));
    }
    if body.first_name.trim().is_empty() {
        return Err(AppError::BadRequest("first name is required".to_owned()));
    }
    if body.last_name.trim().is_empty() {
        return Err(AppError::BadRequest("last name is required".to_owned()));
    }
    if let Some(password) = body.password.as_deref()
        && !password.is_empty()
        && password.len() < 8
    {
        return Err(AppError::BadRequest(
            "password must be at least 8 characters".to_owned(),
        ));
    }

    let conn = state.db.conn()?;

    // NotFound before the role guard, so a missing id never reads as a role error.
    let current_role = role_of(&conn, id).await?;

    if admin.0.id == id && body.role.as_str() != current_role {
        return Err(AppError::BadRequest(
            "you cannot change your own role".to_owned(),
        ));
    }

    let user = service::update(&conn, id, &body).await?;

    Ok(Json(user))
}

async fn remove(
    State(state): State<AppState>,
    admin: AdminUser,
    Path(id): Path<Uuid>,
) -> AppResult<StatusCode> {
    if admin.0.id == id {
        return Err(AppError::BadRequest(
            "you cannot delete your own account".to_owned(),
        ));
    }

    let conn = state.db.conn()?;

    // NotFound before the role guard, so a missing id never reads as a role error.
    let target_role = role_of(&conn, id).await?;

    // Admins cannot remove each other. Self-deletion was already blocked, which left
    // the one case it was meant to prevent still open: two admins can delete each
    // other, and the last one standing can be deleted by nobody but themselves, which
    // they cannot do either. Requiring an admin account to be demoted before it can be
    // removed makes losing admin access a deliberate two-step act rather than one tap.
    if target_role == Role::Admin.as_str() {
        return Err(AppError::BadRequest(
            "an admin cannot be deleted. Change the role to user first".to_owned(),
        ));
    }

    let affected = conn
        .execute("delete from users where id = ?1", [id.to_string()])
        .await?;

    if affected == 0 {
        return Err(AppError::NotFound);
    }

    Ok(StatusCode::NO_CONTENT)
}

/// Reads an account's role, or `NotFound` when there is no such account.
async fn role_of(conn: &libsql::Connection, id: Uuid) -> AppResult<String> {
    let mut rows = conn
        .query("select role from users where id = ?1", [id.to_string()])
        .await?;

    let row = rows.next().await?.ok_or(AppError::NotFound)?;

    Ok(row.get(0)?)
}
