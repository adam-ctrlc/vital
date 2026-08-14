use axum::extract::{Path, Query, State};
use axum::http::StatusCode;
use axum::routing::get;
use axum::{Json, Router};
use serde::Deserialize;
use uuid::Uuid;

use crate::auth::Role;
use crate::auth::extract::AdminUser;
use crate::error::{AppError, AppResult};
use crate::sheets::store;
use crate::state::AppState;
use crate::users::model::{
    CreateUser, SuggestUsername, UpdateUser, User, UsernameSuggestion, clean_optional,
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

    // The needle goes to the store exactly as it was typed. `search::escape_like` was
    // there because ILIKE read `%` and `_` as wildcards; the store matches with
    // `contains`, so escaping first would make a search for a literal percent sign look
    // for a backslash that nobody's name contains.
    let needle = filter(query.q);

    let users = store::users::list(&state.sheets, role.as_deref(), needle.as_deref()).await?;

    Ok(Json(users))
}

/// Backs the "Generate" button on the add-account form.
async fn username_suggestion(
    State(state): State<AppState>,
    _admin: AdminUser,
    Query(query): Query<SuggestUsername>,
) -> AppResult<Json<UsernameSuggestion>> {
    let username =
        service::suggest_username(&state.sheets, &query.first_name, &query.last_name).await?;

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

    // The email and username collision checks used to be two queries here, ahead of the
    // insert, with a unique index behind them to catch anything that slipped through in
    // between. The store now runs both against the rows it is about to append to, which
    // is one read instead of two and keeps the same messages. What is gone is the index:
    // two admins adding an account in the same second can both pass the check and both
    // be appended, so this is a check followed by a write rather than one atomic act.
    //
    // That also means a duplicate is now always a 400 from the check. It used to be able
    // to come back as a 409 when the index caught the race instead.
    service::create(&state.sheets, &body).await?;

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
    let current = store::users::find_by_id(&state.sheets, id)
        .await?
        .ok_or(AppError::NotFound)?;

    if admin.0.id == id && body.role.as_str() != current.user.role {
        return Err(AppError::BadRequest(
            "you cannot change your own role".to_owned(),
        ));
    }

    let user = service::update(&state.sheets, id, &body).await?;

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
    let target = store::users::find_by_id(&state.sheets, id)
        .await?
        .ok_or(AppError::NotFound)?;

    // Admins cannot remove each other. Self-deletion was already blocked, which left
    // the one case it was meant to prevent still open: two admins can delete each
    // other, and the last one standing can be deleted by nobody but themselves, which
    // they cannot do either. Requiring an admin account to be demoted before it can be
    // removed makes losing admin access a deliberate two-step act rather than one tap.
    if target.user.role == Role::Admin.as_str() {
        return Err(AppError::BadRequest(
            "an admin cannot be deleted. Change the role to user first".to_owned(),
        ));
    }

    // The store raises NotFound when the row is already gone, which is what the zero
    // rows-affected check did.
    store::users::delete(&state.sheets, id).await?;

    Ok(StatusCode::NO_CONTENT)
}
