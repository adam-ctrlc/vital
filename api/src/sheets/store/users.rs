use std::time::Duration;

use chrono::{DateTime, Utc};
use uuid::Uuid;

use crate::auth::{Role, password};
use crate::error::{AppError, AppResult};
use crate::sheets::Sheets;
use crate::sheets::schema::{self, USERS_HEADER};
use crate::users::model::{self, CreateUser, UpdateUser, User};

const TAB: &str = "users";
/// Everything under the header. Sheets truncates trailing empty cells, so the width is
/// a ceiling rather than a promise about how long a row comes back.
const RANGE: &str = "users!A2:J";
/// The tenth column, which is where `USERS_HEADER` ends. A test below pins the two
/// together, because widening the header without widening this would write rows that
/// silently drop their last column.
const LAST_COLUMN: char = 'J';

/// Accounts change a handful of times a month and are read on every login, every
/// profile screen and every admin list.
///
/// Five seconds rather than the ten settings uses, because this tab holds credentials:
/// a password changed on one instance is still accepted by another until its copy
/// expires, and that window should be shorter than the time it takes the person who
/// changed it to try the old one again.
const TTL: Duration = Duration::from_secs(5);

/// An account as the sheet holds it: the public user plus the hash.
///
/// The hash is a sibling field rather than one more field on `User` because `User` is
/// serialized straight to the client. A password hash living on a serializable struct
/// is one forgotten `skip` away from being served to a browser.
#[derive(Debug, Clone)]
pub struct StoredUser {
    pub user: User,
    pub password_hash: String,
}

/// Reads a row, or `None` when it is not an account at all.
///
/// The id is the only field that can fail the whole row: every other operation
/// addresses a row by it, so a row without one cannot be edited, deleted or logged
/// into. This is also what keeps a stray header or a note somebody typed under the
/// data out of the account list.
fn from_row(row: &[String]) -> Option<StoredUser> {
    let id: Uuid = schema::text(row, 0)?.parse().ok()?;

    let first_name = schema::text(row, 5).unwrap_or_default();
    let middle_name = schema::text(row, 6);
    let last_name = schema::text(row, 7).unwrap_or_default();

    Some(StoredUser {
        user: User {
            id,
            email: schema::text(row, 1),
            username: schema::text(row, 2).unwrap_or_default(),
            // A blank role must not read as admin. Someone clearing that cell by
            // accident should lose access, never gain it.
            role: schema::text(row, 4).unwrap_or_else(|| Role::User.as_str().to_owned()),
            full_name: model::full_name(&first_name, middle_name.as_deref(), &last_name),
            first_name,
            middle_name,
            last_name,
            // The epoch rather than now: the list is ordered by this, and a row that
            // reads as "now" on every request would move around the screen each time
            // it is refreshed.
            created_at: schema::timestamp(row, 8).unwrap_or(DateTime::UNIX_EPOCH),
        },
        // An empty hash fails every argon2 verification, so a cleared cell locks the
        // account rather than opening it.
        password_hash: schema::text(row, 3).unwrap_or_default(),
    })
}

/// Renders a row.
///
/// `updated_at` is stamped here rather than carried on `User`, because nothing above
/// this layer reads it. The column exists for the person looking at the spreadsheet,
/// who otherwise has no way to tell when a row last changed.
fn to_row(stored: &StoredUser) -> Vec<String> {
    let user = &stored.user;

    vec![
        user.id.to_string(),
        schema::put(user.email.as_ref()),
        user.username.clone(),
        stored.password_hash.clone(),
        user.role.clone(),
        user.first_name.clone(),
        schema::put(user.middle_name.as_ref()),
        user.last_name.clone(),
        schema::put_time(user.created_at),
        schema::put_time(Utc::now()),
    ]
}

/// Pairs each account with the spreadsheet row it sits on.
///
/// The numbering comes before the filter, so a row that fails to parse does not shift
/// the numbers of the rows below it. Getting that backwards would mean an edit landing
/// on somebody else's account.
fn placed(values: &[Vec<String>]) -> Vec<(usize, StoredUser)> {
    values
        .iter()
        .enumerate()
        .filter_map(|(index, row)| from_row(row).map(|stored| (index + 2, stored)))
        .collect()
}

/// The range one account's row occupies.
fn range_for(row: usize) -> String {
    format!("{TAB}!A{row}:{LAST_COLUMN}{row}")
}

/// What a deleted account is overwritten with.
fn blank_row() -> Vec<String> {
    vec![String::new(); USERS_HEADER.len()]
}

/// Whether an account answers to a login identifier.
///
/// Case insensitive on both sides. Postgres compared exactly and could rely on the
/// write path having lowercased both columns; a spreadsheet is editable by hand, so an
/// email typed in with a capital letter would otherwise lock its owner out.
fn answers_to(user: &User, identifier: &str) -> bool {
    // Guarded, or an empty identifier would match every account whose username cell
    // was cleared, and hand one of them out to anyone who posts a blank login form.
    if identifier.is_empty() {
        return false;
    }

    user.username.eq_ignore_ascii_case(identifier)
        || user
            .email
            .as_deref()
            .is_some_and(|email| email.eq_ignore_ascii_case(identifier))
}

/// Whether an account matches a free-text search. The needle must already be lowercase.
///
/// No wildcard escaping, unlike the ILIKE this replaces: `%` was a wildcard to Postgres
/// and is an ordinary character to `contains`, so the needle is literal already.
fn mentions(user: &User, needle: &str) -> bool {
    [
        user.email.as_deref().unwrap_or_default(),
        &user.username,
        &user.first_name,
        user.middle_name.as_deref().unwrap_or_default(),
        &user.last_name,
        &user.full_name,
    ]
    .into_iter()
    .any(|field| field.to_lowercase().contains(needle))
}

/// Rejects an email or username another account already holds.
///
/// Postgres enforced this with a unique index, which made the check and the write one
/// atomic act. A spreadsheet has no such thing, so this is a check followed by a write
/// with a gap in between: two accounts created in that gap can both pass and both be
/// appended. The race is accepted. It needs two admins adding an account in the same
/// second, and the outcome is a duplicate name rather than lost data or a wrong login,
/// since a duplicate resolves to the first matching row.
fn ensure_free<'a>(
    existing: impl IntoIterator<Item = &'a User>,
    email: Option<&str>,
    username: &str,
    keeping: Option<Uuid>,
) -> AppResult<()> {
    for other in existing {
        if keeping == Some(other.id) {
            continue;
        }

        // Only a present email can collide. Accounts without one are ordinary here,
        // the same way Postgres let any number of rows hold a null in a unique column.
        if let Some(email) = email
            && other
                .email
                .as_deref()
                .is_some_and(|taken| taken.eq_ignore_ascii_case(email))
        {
            return Err(AppError::BadRequest("email already registered".to_owned()));
        }

        if other.username.eq_ignore_ascii_case(username) {
            return Err(AppError::BadRequest("username already taken".to_owned()));
        }
    }

    Ok(())
}

/// The first free username for a name, matching what `generate_username` did in SQL.
///
/// Kept identical on purpose: accounts created before the move and after it must be
/// named by the same rule, or two people with the same surname get names that look
/// like they came from different systems. First initial plus surname, stripped to
/// letters and digits, then a number until it is free.
fn free_username<'a>(taken: impl IntoIterator<Item = &'a str>, first: &str, last: &str) -> String {
    let taken: Vec<&str> = taken.into_iter().collect();

    // The initial is taken before stripping, exactly as `left(first_name, 1)` did, so
    // a name starting with punctuation loses its initial here too.
    let seed = format!("{}{last}", first.trim().chars().next().unwrap_or_default());
    let base = match model::clean_username(&seed) {
        stripped if stripped.is_empty() => "user".to_owned(),
        stripped => stripped,
    };

    let mut candidate = base.clone();
    let mut suffix = 1;

    while taken.iter().any(|name| name.eq_ignore_ascii_case(&candidate)) {
        suffix += 1;
        candidate = format!("{base}{suffix}");
    }

    candidate
}

/// Every account, with its row number, served from the cached read.
///
/// Used by everything that only looks. A list screen and a login both read the whole
/// tab, and neither is harmed by a copy that is a few seconds old.
async fn cached(sheets: &Sheets) -> AppResult<Vec<(usize, StoredUser)>> {
    Ok(placed(&sheets.values_cached(RANGE, TTL).await?))
}

/// The same, read fresh.
///
/// Every write takes this path. Deciding that a username is free from a copy up to the
/// TTL old would widen the race in `ensure_free` from milliseconds to seconds, and
/// writes are rare enough to afford the extra call.
async fn current(sheets: &Sheets) -> AppResult<Vec<(usize, StoredUser)>> {
    Ok(placed(&sheets.values(RANGE).await?))
}

/// Finds the account a login identifier names, by email or by username.
///
/// One function for both, because the login form accepts either and the caller cannot
/// tell which it was given. Returns the hash with the user: the caller has to verify a
/// password, and a second lookup to fetch the hash would double the reads on the one
/// path that is already the slowest.
pub async fn find_by_identifier(sheets: &Sheets, identifier: &str) -> AppResult<Option<StoredUser>> {
    let identifier = identifier.trim().to_lowercase();

    Ok(cached(sheets)
        .await?
        .into_iter()
        .find(|(_, stored)| answers_to(&stored.user, &identifier))
        .map(|(_, stored)| stored))
}

/// Finds one account by id.
///
/// `Option` rather than `NotFound`, matching the `fetch_optional` it replaces, because
/// callers differ on what a missing account means: a 404 on a profile read, but a
/// rejected token on an authenticated one.
pub async fn find_by_id(sheets: &Sheets, id: Uuid) -> AppResult<Option<StoredUser>> {
    Ok(cached(sheets)
        .await?
        .into_iter()
        .find(|(_, stored)| stored.user.id == id)
        .map(|(_, stored)| stored))
}

/// Every account, optionally narrowed by role and by a free-text needle.
///
/// Both filters run here rather than in Sheets, which cannot filter at all: the whole
/// tab is read either way, so the choice is only where the rows are discarded.
pub async fn list(sheets: &Sheets, role: Option<&str>, needle: Option<&str>) -> AppResult<Vec<User>> {
    let needle = needle.map(|raw| raw.trim().to_lowercase());

    let mut users: Vec<User> = cached(sheets)
        .await?
        .into_iter()
        .map(|(_, stored)| stored.user)
        .filter(|user| role.is_none_or(|role| user.role == role))
        .filter(|user| {
            needle
                .as_deref()
                .is_none_or(|needle| needle.is_empty() || mentions(user, needle))
        })
        .collect();

    // Ordered here for the same reason the SQL ordered by created_at: rows arrive in
    // insertion order, and a deleted row leaves a gap that append later fills out of
    // sequence, so the sheet's own order is not the order accounts were created in.
    users.sort_by_key(|user| user.created_at);

    Ok(users)
}

/// Offers a username for a name, without taking it.
///
/// Backs the "Generate" button, so the admin sees the name before saving. Nothing
/// reserves it in between: the answer can go stale, and `create` checks again.
pub async fn suggest_username(sheets: &Sheets, first: &str, last: &str) -> AppResult<String> {
    let existing = cached(sheets).await?;

    Ok(free_username(
        existing.iter().map(|(_, stored)| stored.user.username.as_str()),
        first,
        last,
    ))
}

/// Adds an account.
///
/// The id is minted here rather than by the store, because a spreadsheet has no
/// `default gen_random_uuid()` and nothing else in the row is stable enough to
/// identify it: names change and an email is optional.
pub async fn create(sheets: &Sheets, body: &CreateUser) -> AppResult<()> {
    let email = model::clean_optional(body.email.as_deref()).map(|value| value.to_lowercase());
    let password_hash = password::hash(&body.password)?;
    let first_name = body.first_name.trim().to_owned();
    let middle_name = model::clean_optional(body.middle_name.as_deref());
    let last_name = body.last_name.trim().to_owned();

    sheets.ensure_tab(TAB, USERS_HEADER).await?;
    let existing = current(sheets).await?;

    // A blank username defers to the formula, so the generation rule has one home
    // whether the admin typed a name or left it to autogenerate.
    let username = match body.username.as_deref().map(model::clean_username) {
        Some(name) if !name.is_empty() => name,
        _ => free_username(
            existing.iter().map(|(_, stored)| stored.user.username.as_str()),
            &first_name,
            &last_name,
        ),
    };

    ensure_free(
        existing.iter().map(|(_, stored)| &stored.user),
        email.as_deref(),
        &username,
        None,
    )?;

    let stored = StoredUser {
        user: User {
            id: Uuid::new_v4(),
            email,
            username,
            role: body.role.as_str().to_owned(),
            full_name: model::full_name(&first_name, middle_name.as_deref(), &last_name),
            first_name,
            middle_name,
            last_name,
            created_at: Utc::now(),
        },
        password_hash,
    };

    sheets.append(RANGE, vec![to_row(&stored)]).await?;
    sheets.invalidate(TAB).await;

    Ok(())
}

/// Applies an admin edit and returns the account as it now stands.
///
/// A blank username keeps the current one and a blank password leaves the hash alone,
/// which is what `coalesce` did in the SQL. Here it is a read of the old row first:
/// the whole row is rewritten, so a field that is meant to stay the same has to be
/// carried across by hand or it would be blanked.
pub async fn update(sheets: &Sheets, id: Uuid, body: &UpdateUser) -> AppResult<User> {
    let existing = current(sheets).await?;
    let (row, stored) = existing
        .iter()
        .find(|(_, stored)| stored.user.id == id)
        .ok_or(AppError::NotFound)?;

    let email = model::clean_optional(body.email.as_deref()).map(|value| value.to_lowercase());
    let username = match body.username.as_deref().map(model::clean_username) {
        Some(name) if !name.is_empty() => name,
        _ => stored.user.username.clone(),
    };
    let password_hash = match body.password.as_deref() {
        Some(password) if !password.is_empty() => password::hash(password)?,
        _ => stored.password_hash.clone(),
    };

    ensure_free(
        existing.iter().map(|(_, other)| &other.user),
        email.as_deref(),
        &username,
        Some(id),
    )?;

    let first_name = body.first_name.trim().to_owned();
    let middle_name = model::clean_optional(body.middle_name.as_deref());
    let last_name = body.last_name.trim().to_owned();

    let next = StoredUser {
        user: User {
            id,
            email,
            username,
            role: body.role.as_str().to_owned(),
            full_name: model::full_name(&first_name, middle_name.as_deref(), &last_name),
            first_name,
            middle_name,
            last_name,
            // Kept from the stored row. It is when the account was created, and
            // rewriting the row is not a new creation.
            created_at: stored.user.created_at,
        },
        password_hash,
    };

    sheets.update(&range_for(*row), vec![to_row(&next)]).await?;
    sheets.invalidate(TAB).await;

    Ok(next.user)
}

/// Replaces one account's password hash.
///
/// Separate from `update` because the caller is the account owner rather than an
/// admin, and it has no business supplying a role. It still rewrites the whole row,
/// since Sheets has no per-cell write worth having, so a profile edit landing in the
/// same moment is overwritten by whichever call finishes last.
pub async fn set_password(sheets: &Sheets, id: Uuid, password: &str) -> AppResult<()> {
    let (row, stored) = current(sheets)
        .await?
        .into_iter()
        .find(|(_, stored)| stored.user.id == id)
        .ok_or(AppError::NotFound)?;

    let next = StoredUser {
        password_hash: password::hash(password)?,
        ..stored
    };

    sheets.update(&range_for(row), vec![to_row(&next)]).await?;
    sheets.invalidate(TAB).await;

    Ok(())
}

/// Removes an account by blanking its row.
///
/// The row itself stays. Taking it out needs a `deleteDimension` batch update, which
/// renumbers every row below it, and another request already holding a row number
/// would then write to the wrong account. A blank row costs a few cells and keeps
/// every number stable; `from_row` skips it because it has no id.
pub async fn delete(sheets: &Sheets, id: Uuid) -> AppResult<()> {
    let (row, _) = current(sheets)
        .await?
        .into_iter()
        .find(|(_, stored)| stored.user.id == id)
        .ok_or(AppError::NotFound)?;

    sheets.update(&range_for(row), vec![blank_row()]).await?;
    sheets.invalidate(TAB).await;

    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn row(values: &[&str]) -> Vec<String> {
        values.iter().map(|value| (*value).to_owned()).collect()
    }

    fn account(id: &str, email: &str, username: &str) -> Vec<String> {
        row(&[
            id,
            email,
            username,
            "$argon2id$v=19$m=1,t=1,p=1$c2FsdA$aGFzaA",
            "user",
            "John",
            "Adam",
            "Cuenca",
            "2026-08-14T09:00:00Z",
            "2026-08-14T09:00:00Z",
        ])
    }

    const ID: &str = "3f2504e0-4f89-41d3-9a0c-0305e82c3301";
    const OTHER_ID: &str = "3f2504e0-4f89-41d3-9a0c-0305e82c3302";

    #[test]
    fn a_full_row_reads_back_as_written() {
        let original = from_row(&account(ID, "john@dynavolt.test", "jcuenca")).unwrap();

        let round_tripped = from_row(&to_row(&original)).unwrap();

        assert_eq!(round_tripped.user.id, original.user.id);
        assert_eq!(round_tripped.user.email.as_deref(), Some("john@dynavolt.test"));
        assert_eq!(round_tripped.user.username, "jcuenca");
        assert_eq!(round_tripped.user.full_name, "John Adam Cuenca");
        assert_eq!(round_tripped.user.created_at, original.user.created_at);
        assert_eq!(round_tripped.password_hash, original.password_hash);
    }

    #[test]
    fn the_header_row_is_skipped_rather_than_read_as_an_account() {
        let header: Vec<String> = USERS_HEADER.iter().map(|column| (*column).to_owned()).collect();

        assert!(from_row(&header).is_none());
    }

    #[test]
    fn an_account_without_an_email_writes_a_blank_cell_rather_than_the_word_none() {
        let stored = from_row(&account(ID, "", "jcuenca")).unwrap();

        assert_eq!(to_row(&stored)[1], "");
        assert!(from_row(&to_row(&stored)).unwrap().user.email.is_none());
    }

    #[test]
    fn a_hand_cleared_role_reads_as_the_lesser_privilege() {
        let mut cleared = account(ID, "john@dynavolt.test", "jcuenca");
        cleared[4] = String::new();

        assert_eq!(from_row(&cleared).unwrap().user.role, "user");
    }

    #[test]
    fn a_hand_cleared_password_hash_locks_the_account_rather_than_opening_it() {
        let mut cleared = account(ID, "john@dynavolt.test", "jcuenca");
        cleared[3] = String::new();

        let stored = from_row(&cleared).unwrap();

        assert!(!password::verify("", &stored.password_hash));
        assert!(!password::verify("anything", &stored.password_hash));
    }

    #[test]
    fn a_hand_cleared_created_at_reads_as_the_epoch_so_the_list_order_holds_still() {
        let mut cleared = account(ID, "john@dynavolt.test", "jcuenca");
        cleared[8] = String::new();

        assert_eq!(from_row(&cleared).unwrap().user.created_at, DateTime::UNIX_EPOCH);
    }

    #[test]
    fn a_junk_row_does_not_shift_the_row_numbers_of_the_accounts_below_it() {
        let values = vec![
            account(ID, "john@dynavolt.test", "jcuenca"),
            row(&["a note somebody typed"]),
            account(OTHER_ID, "mary@dynavolt.test", "mcuenca"),
        ];

        let placed = placed(&values);

        assert_eq!(placed.len(), 2);
        assert_eq!(placed[0].0, 2);
        assert_eq!(placed[1].0, 4);
        assert_eq!(range_for(placed[1].0), "users!A4:J4");
    }

    #[test]
    fn the_written_range_covers_every_column_in_the_header() {
        let width = LAST_COLUMN as usize - 'A' as usize + 1;

        assert_eq!(width, USERS_HEADER.len());
        assert_eq!(blank_row().len(), USERS_HEADER.len());
    }

    #[test]
    fn an_identifier_matches_either_the_email_or_the_username() {
        let user = from_row(&account(ID, "john@dynavolt.test", "jcuenca")).unwrap().user;

        assert!(answers_to(&user, "jcuenca"));
        assert!(answers_to(&user, "john@dynavolt.test"));
        assert!(!answers_to(&user, "mcuenca"));
    }

    #[test]
    fn an_empty_identifier_matches_nobody() {
        let mut nameless = account(ID, "", "");
        nameless[2] = String::new();

        let user = from_row(&nameless).unwrap().user;

        assert!(!answers_to(&user, ""));
    }

    #[test]
    fn a_search_needle_matches_the_composed_full_name() {
        let user = from_row(&account(ID, "john@dynavolt.test", "jcuenca")).unwrap().user;

        assert!(mentions(&user, "john adam"));
        assert!(mentions(&user, "dynavolt.test"));
        assert!(!mentions(&user, "santos"));
    }

    #[test]
    fn a_percent_sign_in_a_search_is_matched_literally_rather_than_as_a_wildcard() {
        let mut odd = account(ID, "john@dynavolt.test", "jcuenca");
        odd[7] = "100%".to_owned();

        let user = from_row(&odd).unwrap().user;

        assert!(mentions(&user, "100%"));
        assert!(!mentions(&user, "%santos%"));
    }

    #[test]
    fn an_email_another_account_already_holds_is_refused() {
        let existing = [
            from_row(&account(ID, "john@dynavolt.test", "jcuenca")).unwrap().user,
        ];

        let refused = ensure_free(&existing, Some("john@dynavolt.test"), "jsantos", None);

        assert!(matches!(refused, Err(AppError::BadRequest(message)) if message.contains("email")));
    }

    #[test]
    fn a_username_another_account_already_holds_is_refused() {
        let existing = [
            from_row(&account(ID, "john@dynavolt.test", "jcuenca")).unwrap().user,
        ];

        let refused = ensure_free(&existing, None, "JCuenca", None);

        assert!(matches!(refused, Err(AppError::BadRequest(message)) if message.contains("username")));
    }

    #[test]
    fn two_accounts_without_an_email_are_not_a_collision() {
        let existing = [from_row(&account(ID, "", "jcuenca")).unwrap().user];

        assert!(ensure_free(&existing, None, "msantos", None).is_ok());
    }

    #[test]
    fn the_account_being_edited_does_not_collide_with_itself() {
        let existing = [
            from_row(&account(ID, "john@dynavolt.test", "jcuenca")).unwrap().user,
        ];
        let id: Uuid = ID.parse().unwrap();

        assert!(ensure_free(&existing, Some("john@dynavolt.test"), "jcuenca", Some(id)).is_ok());
    }

    #[test]
    fn a_taken_username_gets_a_number_appended_starting_at_two() {
        assert_eq!(free_username([], "John", "Cuenca"), "jcuenca");
        assert_eq!(free_username(["jcuenca"], "John", "Cuenca"), "jcuenca2");
        assert_eq!(
            free_username(["jcuenca", "jcuenca2"], "John", "Cuenca"),
            "jcuenca3"
        );
    }

    #[test]
    fn a_name_with_nothing_usable_in_it_still_yields_a_username() {
        assert_eq!(free_username([], "", ""), "user");
        assert_eq!(free_username(["user"], "!", "?"), "user2");
    }
}
