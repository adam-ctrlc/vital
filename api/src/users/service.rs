use uuid::Uuid;

use crate::error::AppResult;
use crate::sheets::Sheets;
use crate::sheets::store;
use crate::users::model::{CreateUser, UpdateUser, User};

/// Offers an available username derived from a name.
///
/// The rule that picks it now lives in the store rather than a SQL function, but the
/// caller still asks the domain rather than the storage, which is what let the storage
/// change underneath it.
pub async fn suggest_username(sheets: &Sheets, first: &str, last: &str) -> AppResult<String> {
    store::users::suggest_username(sheets, first, last).await
}

/// Adds an account.
///
/// The username generation, the password hashing and the uniqueness check all sit in
/// the store now, because only it can read the rest of the tab to decide any of them.
pub async fn create(sheets: &Sheets, body: &CreateUser) -> AppResult<()> {
    store::users::create(sheets, body).await
}

/// Applies an admin edit and returns the account as it now stands.
///
/// A blank username still keeps the current one and a blank password still leaves the
/// hash alone, which is what `coalesce` did before.
pub async fn update(sheets: &Sheets, id: Uuid, body: &UpdateUser) -> AppResult<User> {
    store::users::update(sheets, id, body).await
}
