use std::time::Duration;

use chrono::{DateTime, Utc};
use uuid::Uuid;

use crate::error::{AppError, AppResult};
use crate::notifications::model::RegisterToken;
use crate::sheets::schema::{self, PUSH_TOKENS_HEADER};
use crate::sheets::Sheets;

const TAB: &str = "push_tokens";
/// Every row under the header, open ended because the number of devices is not known.
const DATA: &str = "push_tokens!A2:E";
const LAST_COLUMN: char = 'E';
/// The sheet row the first registration sits on, which is what turns a position in a read
/// into a range to write back to.
const FIRST_ROW: usize = 2;

/// The list changes when somebody installs the app or signs out, a handful of times a
/// month, and is read every time an alert fans out.
///
/// A minute, far longer than the live views use, because there is nothing to see here
/// changing. A write drops the cache on the instance that made it, so the window only
/// costs a device that registered against a different warm instance, and only until it
/// expires: that device misses at most one alert.
const TTL: Duration = Duration::from_secs(60);

/// One device's registration, as the row holds it.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PushToken {
    pub token: String,
    /// Absent when the cell holds something that is not a uuid, which takes a hand edit to
    /// produce. Such a row still receives pushes; it just cannot be matched to the account
    /// that signs out, so it has to be cleared in the spreadsheet.
    pub user_id: Option<Uuid>,
    pub platform: String,
    /// The Android channel to deliver on, which is where the tone comes from.
    pub channel_id: Option<String>,
    pub created_at: Option<DateTime<Utc>>,
}

/// Reads a row, skipping the ones that are not registrations.
///
/// A row with no token is either a blank line somebody left behind or one this module
/// cleared when a device unregistered. Neither can be pushed to, and letting one through
/// would put an empty `to` in an Expo batch and have the whole batch rejected.
fn from_row(row: &[String]) -> Option<PushToken> {
    let token = schema::text(row, 0)?;

    Some(PushToken {
        token,
        user_id: schema::text(row, 1).and_then(|value| Uuid::parse_str(&value).ok()),
        platform: schema::text(row, 2).unwrap_or_else(|| "unknown".to_owned()),
        channel_id: schema::text(row, 3),
        created_at: schema::timestamp(row, 4),
    })
}

fn to_row(entry: &PushToken) -> Vec<String> {
    vec![
        entry.token.clone(),
        schema::put(entry.user_id),
        entry.platform.clone(),
        schema::put(entry.channel_id.as_deref()),
        entry.created_at.map(schema::put_time).unwrap_or_default(),
    ]
}

/// The row a registration should be stored as.
///
/// The trimming and the fallback platform used to be arguments to a bind in the service.
/// They belong here now, because this module decides what a stored row looks like, and a
/// channel cell holding a single space would send a push to a channel Android has never
/// heard of and lose the alert tone with it.
fn normalized(user_id: Uuid, body: &RegisterToken, now: DateTime<Utc>) -> PushToken {
    PushToken {
        token: body.token.trim().to_owned(),
        user_id: Some(user_id),
        platform: body
            .platform
            .as_deref()
            .map(str::trim)
            .filter(|platform| !platform.is_empty())
            .unwrap_or("unknown")
            .to_owned(),
        channel_id: body
            .channel_id
            .as_deref()
            .map(str::trim)
            .filter(|channel| !channel.is_empty())
            .map(ToOwned::to_owned),
        created_at: Some(now),
    }
}

/// Where a token sits in a block of rows, if it is there at all.
///
/// A linear scan, because a spreadsheet has no index to ask. The list is one row per
/// installed device, so the scan is never the expensive part of the call; the read that
/// produced the rows is.
fn position(rows: &[Vec<String>], token: &str) -> Option<usize> {
    rows.iter()
        .position(|row| schema::cell(row, 0) == Some(token))
}

/// The range covering one registration, from its position in a read of `DATA`.
fn row_range(index: usize) -> String {
    let row = index + FIRST_ROW;

    format!("{TAB}!A{row}:{LAST_COLUMN}{row}")
}

/// The cells that mark a row as no longer a registration.
///
/// Every column, not just the token: leaving a user id behind in an otherwise empty row
/// would keep an account's identifier in the spreadsheet after they asked to be forgotten.
fn blank_row() -> Vec<String> {
    vec![String::new(); PUSH_TOKENS_HEADER.len()]
}

/// Stores a device's push token, replacing whatever was registered under it before.
///
/// The token is the identity, not the user: an app reinstall or a second account on the
/// same phone reuses it, and the row has to follow the account that most recently signed
/// in or the alert goes to whoever had the phone last.
///
/// Postgres did this with `on conflict (token) do update` and a unique index underneath.
/// Here it is a read, then either an update or an append, and the gap between them is
/// real: two registrations of the same token arriving at once both fail to find it and
/// both append, leaving one device with two rows and a duplicate of every alert. Nothing
/// in a spreadsheet can enforce what the index enforced. It is accepted because the cost
/// is a repeated notification rather than a wrong one, and because the two rows are
/// visible in the tab and one can be deleted by hand.
pub async fn register(sheets: &Sheets, user_id: Uuid, body: &RegisterToken) -> AppResult<()> {
    let mut entry = normalized(user_id, body, Utc::now());

    // Refused rather than stored, because an empty first cell is how this module marks a
    // row as gone. Writing one would create a registration that reads back as absent and
    // can never be found again to be removed.
    if entry.token.is_empty() {
        return Err(AppError::BadRequest("push token is empty".to_owned()));
    }

    sheets.ensure_tab(TAB, PUSH_TOKENS_HEADER).await?;

    let rows = sheets.values(DATA).await?;

    match position(&rows, &entry.token) {
        Some(index) => {
            // The date the device first registered is worth keeping. The app registers on
            // every launch, so taking the current time here would reset it daily and leave
            // a column that only ever says today.
            entry.created_at = rows
                .get(index)
                .and_then(|row| schema::timestamp(row, 4))
                .or(entry.created_at);

            sheets.update(&row_range(index), vec![to_row(&entry)]).await?;
        }
        // Appended at the end rather than into a row a previous unregister cleared.
        // Reusing one would mean holding a position across two calls, and an append is
        // the one write here that cannot land on somebody else's row.
        None => {
            sheets
                .append(&format!("{TAB}!A1"), vec![to_row(&entry)])
                .await?;
        }
    }

    sheets.invalidate(TAB).await;

    Ok(())
}

/// Removes a device's registration, if it belongs to the user asking.
///
/// The owner check is the one the delete carried in its `where` clause. A token is a
/// phone, and one account signing out must not silence a phone that belongs to somebody
/// else. A token that is not there, or is not theirs, is a success: the caller asked for
/// it to be gone and it is.
///
/// The row is blanked rather than deleted. Removing a row shifts every row below it, which
/// would move registrations out from under a position another request is already holding.
/// The tab therefore only grows: a phone that signs in and out repeatedly leaves an empty
/// row each time. Reads skip them, so the cost is cells rather than correctness.
pub async fn unregister(sheets: &Sheets, token: &str, user_id: Uuid) -> AppResult<()> {
    let token = token.trim();

    sheets.ensure_tab(TAB, PUSH_TOKENS_HEADER).await?;

    let rows = sheets.values(DATA).await?;
    let Some(index) = position(&rows, token) else {
        return Ok(());
    };

    let owner = rows
        .get(index)
        .and_then(|row| from_row(row))
        .and_then(|entry| entry.user_id);
    if owner != Some(user_id) {
        return Ok(());
    }

    sheets.update(&row_range(index), vec![blank_row()]).await?;
    sheets.invalidate(TAB).await;

    Ok(())
}

/// Every registered device, for fanning an alert out.
///
/// There is no filter to apply: an overload is announced to everyone who installed the
/// app, and there was no `where` clause here under Postgres either. The channel comes
/// back with the token because the tone is a per device choice and the batch has to carry
/// it per message.
///
/// A spreadsheet with no such tab yet reports upstream failure rather than an empty list.
/// That case is a deployment where nobody has ever registered, where the outcome either
/// way is that no phone rings, and the caller already logs and swallows the failure.
pub async fn all(sheets: &Sheets) -> AppResult<Vec<PushToken>> {
    let rows = sheets.values_cached(DATA, TTL).await?;

    Ok(rows.iter().filter_map(|row| from_row(row)).collect())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn row(values: &[&str]) -> Vec<String> {
        values.iter().map(|value| (*value).to_owned()).collect()
    }

    fn user() -> Uuid {
        Uuid::parse_str("6f1d1c9e-0d5a-4a1a-9f9d-2b6a4e3c1a77").expect("a valid test uuid")
    }

    fn body(token: &str, platform: Option<&str>, channel: Option<&str>) -> RegisterToken {
        RegisterToken {
            token: token.to_owned(),
            platform: platform.map(ToOwned::to_owned),
            channel_id: channel.map(ToOwned::to_owned),
        }
    }

    fn now() -> DateTime<Utc> {
        DateTime::parse_from_rfc3339("2026-08-14T02:30:00Z")
            .expect("the test timestamp should be valid")
            .with_timezone(&Utc)
    }

    #[test]
    fn a_registration_reads_back_as_written() {
        let entry = normalized(user(), &body("ExponentPushToken[abc]", Some("android"), Some("alerts")), now());

        assert_eq!(from_row(&to_row(&entry)), Some(entry));
    }

    #[test]
    fn a_surrounding_space_never_reaches_the_stored_token() {
        // The app sends what the OS handed it, and a token with a newline on the end is a
        // token that matches nothing on the next launch and registers a second time.
        let entry = normalized(user(), &body("  ExponentPushToken[abc]\n", None, None), now());

        assert_eq!(entry.token, "ExponentPushToken[abc]");
    }

    #[test]
    fn a_client_that_names_no_platform_is_stored_as_unknown() {
        let entry = normalized(user(), &body("ExponentPushToken[abc]", None, None), now());

        assert_eq!(entry.platform, "unknown");
    }

    #[test]
    fn a_blank_channel_is_stored_as_absence_rather_than_an_empty_channel() {
        // An empty channel id sent to Expo is worse than none: none falls back to the
        // app's default channel and still makes a sound.
        let entry = normalized(user(), &body("ExponentPushToken[abc]", Some("android"), Some("   ")), now());

        assert_eq!(entry.channel_id, None);
    }

    #[test]
    fn a_cleared_row_is_skipped_rather_than_read_as_a_device() {
        assert_eq!(from_row(&blank_row()), None);
        assert_eq!(from_row(&[]), None);
    }

    #[test]
    fn a_row_with_a_mangled_user_id_still_holds_a_token_to_push_to() {
        let damaged = row(&["ExponentPushToken[abc]", "not-a-uuid", "ios", "", ""]);
        let entry = from_row(&damaged).expect("a row with a token is a registration");

        assert_eq!(entry.user_id, None);
        assert_eq!(entry.token, "ExponentPushToken[abc]");
    }

    #[test]
    fn a_token_is_found_by_the_row_it_sits_on() {
        let rows = vec![
            row(&["ExponentPushToken[aaa]", "", "ios", "", ""]),
            blank_row(),
            row(&["ExponentPushToken[bbb]", "", "android", "", ""]),
        ];

        assert_eq!(position(&rows, "ExponentPushToken[bbb]"), Some(2));
        assert_eq!(row_range(2), "push_tokens!A4:E4");
        assert_eq!(position(&rows, "ExponentPushToken[ccc]"), None);
    }

    #[test]
    fn the_written_range_covers_every_column_in_the_header() {
        // Widening the header without widening the range would write rows that quietly
        // drop their last column, which here would be the date or the channel.
        let width = u8::try_from(PUSH_TOKENS_HEADER.len()).expect("the header is short");

        assert_eq!(LAST_COLUMN, char::from(b'A' + width - 1));
        assert_eq!(row_range(0), "push_tokens!A2:E2");
    }
}
