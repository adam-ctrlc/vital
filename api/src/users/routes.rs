use axum::extract::{Path, Query, State};
use axum::http::StatusCode;
use axum::routing::get;
use axum::{Json, Router};
use serde::Deserialize;
use uuid::Uuid;

use crate::auth::Role;
use crate::auth::extract::AdminUser;
use crate::error::{AppError, AppResult};
use crate::search;
use crate::state::AppState;
use crate::users::model::{
    CreateUser, SuggestUsername, UpdateUser, User, UsernameSuggestion, clean_optional,
    clean_username,
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

    let users = sqlx::query_as::<_, User>(
        "select id, email, username, role, first_name, middle_name, last_name,
                trim(concat_ws(' ', first_name, middle_name, last_name)) as full_name,
                created_at
         from users
         where ($1::text is null or role = $1)
           and ($2::text is null
                or email ilike '%' || $2 || '%'
                or username ilike '%' || $2 || '%'
                or first_name ilike '%' || $2 || '%'
                or middle_name ilike '%' || $2 || '%'
                or last_name ilike '%' || $2 || '%'
                or trim(concat_ws(' ', first_name, middle_name, last_name)) ilike '%' || $2 || '%')
         order by created_at",
    )
    .bind(role)
    .bind(filter(query.q).map(|needle| search::escape_like(&needle)))
    .fetch_all(&state.pool)
    .await?;

    Ok(Json(users))
}

/// Backs the "Generate" button on the add-account form.
async fn username_suggestion(
    State(state): State<AppState>,
    _admin: AdminUser,
    Query(query): Query<SuggestUsername>,
) -> AppResult<Json<UsernameSuggestion>> {
    let username = service::suggest_username(&state.pool, &query.first_name, &query.last_name).await?;

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

    let taken: Option<Uuid> = sqlx::query_scalar("select id from users where email = $1")
        .bind(email.clone())
        .fetch_optional(&state.pool)
        .await?;

    if taken.is_some() {
        return Err(AppError::BadRequest("email already registered".to_owned()));
    }

    // Only a username the admin typed is checked here; a blank one is generated in
    // the service, and the formula only ever returns a free name.
    if let Some(username) = body.username.as_deref().map(clean_username)
        && !username.is_empty()
    {
        let clash: Option<Uuid> = sqlx::query_scalar("select id from users where username = $1")
            .bind(&username)
            .fetch_optional(&state.pool)
            .await?;

        if clash.is_some() {
            return Err(AppError::BadRequest("username already taken".to_owned()));
        }
    }

    service::create(&state.pool, &body).await?;

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

    // NotFound before the role guard, so a missing id never reads as a role error.
    let current_role: String = sqlx::query_scalar("select role from users where id = $1")
        .bind(id)
        .fetch_optional(&state.pool)
        .await?
        .ok_or(AppError::NotFound)?;

    if admin.0.id == id && body.role.as_str() != current_role {
        return Err(AppError::BadRequest(
            "you cannot change your own role".to_owned(),
        ));
    }

    let user = service::update(&state.pool, id, &body).await?;

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

    // NotFound before the role guard, so a missing id never reads as a role error.
    let target_role: String = sqlx::query_scalar("select role from users where id = $1")
        .bind(id)
        .fetch_optional(&state.pool)
        .await?
        .ok_or(AppError::NotFound)?;

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

    let affected = sqlx::query("delete from users where id = $1")
        .bind(id)
        .execute(&state.pool)
        .await?
        .rows_affected();

    if affected == 0 {
        return Err(AppError::NotFound);
    }

    Ok(StatusCode::NO_CONTENT)
}
