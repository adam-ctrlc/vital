use libsql::{Connection, params};
use uuid::Uuid;

use crate::auth::password;
use crate::error::{AppError, AppResult};
use crate::users::model::{
    CreateUser, UpdateUser, User, clean_optional, clean_username, user_columns,
};

/// Finds an available username derived from a name.
///
/// Postgres did this in a `generate_username` plpgsql function that looped inside the
/// statement. SQLite has no procedural language, so the same rule runs here: the first
/// initial and the surname, stripped to alphanumerics and lowercased, then a numeric
/// suffix from 2 upwards until nothing holds the name.
///
/// The loop is a read at a time rather than one clever statement because the answer is
/// advisory either way. Two admins generating at once can be handed the same name, and
/// the unique index on `username` is what turns the second insert into a conflict.
pub async fn suggest_username(conn: &Connection, first: &str, last: &str) -> AppResult<String> {
    let initial: String = first.trim().chars().take(1).collect();
    let base = match clean_username(&format!("{initial}{}", last.trim())) {
        name if name.is_empty() => "user".to_owned(),
        name => name,
    };

    let mut candidate = base.clone();
    let mut suffix = 1;

    while is_taken(conn, &candidate).await? {
        suffix += 1;
        candidate = format!("{base}{suffix}");
    }

    Ok(candidate)
}

async fn is_taken(conn: &Connection, username: &str) -> AppResult<bool> {
    let mut rows = conn
        .query("select 1 from users where username = ?1", [username])
        .await?;

    Ok(rows.next().await?.is_some())
}

pub async fn create(conn: &Connection, body: &CreateUser) -> AppResult<()> {
    let password_hash = password::hash(&body.password)?;

    // A blank or absent username defers to the generation rule, so it has one home
    // whether the admin typed a name or left it to autogenerate.
    let username = match body.username.as_deref().map(clean_username) {
        Some(name) if !name.is_empty() => name,
        _ => suggest_username(conn, &body.first_name, &body.last_name).await?,
    };

    // The id is generated here because SQLite has no `gen_random_uuid()`. It is bound
    // as text, which is what a uuid already is on the wire.
    conn.execute(
        "insert into users (id, email, username, password_hash, role,
                            first_name, middle_name, last_name)
         values (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)",
        params![
            Uuid::new_v4().to_string(),
            clean_optional(body.email.as_deref()).map(|value| value.to_lowercase()),
            username,
            password_hash,
            body.role.as_str(),
            body.first_name.trim(),
            clean_optional(body.middle_name.as_deref()),
            body.last_name.trim(),
        ],
    )
    .await?;

    Ok(())
}

/// Applies an admin edit. A blank or absent username keeps the current one, and a
/// blank or absent password leaves the hash untouched; both defer to `coalesce`.
/// RETURNING composes the row in the same shape the list endpoint serves.
pub async fn update(conn: &Connection, id: Uuid, body: &UpdateUser) -> AppResult<User> {
    let password_hash = match body.password.as_deref() {
        Some(password) if !password.is_empty() => Some(password::hash(password)?),
        _ => None,
    };

    let username = match body.username.as_deref().map(clean_username) {
        Some(name) if !name.is_empty() => Some(name),
        _ => None,
    };

    // `updated_at` is set by hand. Postgres kept it current with a trigger, and SQLite
    // could do the same, but the schema is one file of tables and indexes; a trigger
    // per table to stamp one column is more machinery than the column is worth.
    let mut rows = conn
        .query(
            concat!(
                "update users
                 set email = ?1, role = ?2, first_name = ?3, middle_name = ?4, last_name = ?5,
                     username = coalesce(?6, username),
                     password_hash = coalesce(?7, password_hash),
                     updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
                 where id = ?8
                 returning ",
                user_columns!()
            ),
            params![
                clean_optional(body.email.as_deref()).map(|value| value.to_lowercase()),
                body.role.as_str(),
                body.first_name.trim(),
                clean_optional(body.middle_name.as_deref()),
                body.last_name.trim(),
                username,
                password_hash,
                id.to_string(),
            ],
        )
        .await?;

    let row = rows.next().await?.ok_or(AppError::NotFound)?;

    User::from_row(&row)
}
