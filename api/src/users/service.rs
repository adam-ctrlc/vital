use sqlx::PgPool;
use uuid::Uuid;

use crate::auth::password;
use crate::error::{AppError, AppResult};
use crate::users::model::{CreateUser, UpdateUser, User, clean_optional, clean_username};

/// Asks the database for an available username derived from a name.
pub async fn suggest_username(pool: &PgPool, first: &str, last: &str) -> AppResult<String> {
    let username: String = sqlx::query_scalar("select generate_username($1, $2)")
        .bind(first.trim())
        .bind(last.trim())
        .fetch_one(pool)
        .await?;

    Ok(username)
}

pub async fn create(pool: &PgPool, body: &CreateUser) -> AppResult<()> {
    let password_hash = password::hash(&body.password)?;

    // A blank or absent username defers to the database formula, so the generation
    // rule has one home whether the admin typed a name or left it to autogenerate.
    let username = match body.username.as_deref().map(clean_username) {
        Some(name) if !name.is_empty() => name,
        _ => suggest_username(pool, &body.first_name, &body.last_name).await?,
    };

    sqlx::query(
        "insert into users (email, username, password_hash, role, first_name, middle_name, last_name)
         values ($1, $2, $3, $4, $5, $6, $7)",
    )
    .bind(clean_optional(body.email.as_deref()).map(|value| value.to_lowercase()))
    .bind(username)
    .bind(password_hash)
    .bind(body.role.as_str())
    .bind(body.first_name.trim())
    .bind(clean_optional(body.middle_name.as_deref()))
    .bind(body.last_name.trim())
    .execute(pool)
    .await?;

    Ok(())
}

/// Applies an admin edit. A blank or absent username keeps the current one, and a
/// blank or absent password leaves the hash untouched; both defer to `coalesce`.
/// RETURNING composes the row in the same shape the list endpoint serves.
pub async fn update(pool: &PgPool, id: Uuid, body: &UpdateUser) -> AppResult<User> {
    let password_hash = match body.password.as_deref() {
        Some(password) if !password.is_empty() => Some(password::hash(password)?),
        _ => None,
    };

    let username = match body.username.as_deref().map(clean_username) {
        Some(name) if !name.is_empty() => Some(name),
        _ => None,
    };

    let user = sqlx::query_as::<_, User>(
        "update users
         set email = $1, role = $2, first_name = $3, middle_name = $4, last_name = $5,
             username = coalesce($6, username),
             password_hash = coalesce($7, password_hash)
         where id = $8
         returning id, email, username, role, first_name, middle_name, last_name,
                   trim(concat_ws(' ', first_name, middle_name, last_name)) as full_name,
                   created_at",
    )
    .bind(clean_optional(body.email.as_deref()).map(|value| value.to_lowercase()))
    .bind(body.role.as_str())
    .bind(body.first_name.trim())
    .bind(clean_optional(body.middle_name.as_deref()))
    .bind(body.last_name.trim())
    .bind(username)
    .bind(password_hash)
    .bind(id)
    .fetch_optional(pool)
    .await?
    .ok_or(AppError::NotFound)?;

    Ok(user)
}
