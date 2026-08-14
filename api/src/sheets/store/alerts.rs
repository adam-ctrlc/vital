//! Alerts, in the spreadsheet.
//!
//! Postgres gave this table a sequence, a partial unique index and row level locks, and
//! the alert logic leaned on all three: ids that could not repeat, one open alert per
//! kind, and a claim only one caller could win. None of them exist in a spreadsheet, so
//! each rule here is kept best effort and every function says what it stopped promising.
//! Taken together: an ongoing overload can end up with two open rows, and can announce
//! itself twice in the same minute.

use std::time::Duration;

use chrono::{DateTime, Utc};
use uuid::Uuid;

use crate::alerts::model::{Alert, AlertWithReading};
use crate::error::{AppError, AppResult};
use crate::page::Page;
use crate::sheets::Sheets;
use crate::sheets::schema::{self, ALERTS_HEADER};

const TAB: &str = "alerts";
/// Everything under the header. Open ended, so a raise does not have to widen it.
const RANGE: &str = "alerts!A2:K";
/// Ids alone, for the one question a raise has to ask before it appends.
const IDS: &str = "alerts!A2:A";

/// How long an ongoing condition waits before announcing itself again.
///
/// Carried over unchanged from the Postgres version, and for the same reason: an alarm
/// that speaks once and goes quiet while the fault continues is not an alarm, and one
/// that speaks every five seconds gets the phone thrown across the room.
const RENOTIFY_AFTER_SECONDS: i64 = 60;

/// Alerts are read by a dashboard that polls while somebody watches it, and written only
/// when a threshold is crossed or a responder presses acknowledge.
///
/// Five seconds is one reading interval, so a raise is visible by the poll after the one
/// that caused it at worst, and a screen left open costs one read every five seconds
/// rather than one a second. Writes drop the cache, so within an instance an
/// acknowledgement shows up immediately; the window only bites across warm instances.
const TTL: Duration = Duration::from_secs(5);

/// What the list endpoint asks for, as one value rather than five positional arguments.
pub struct Filter {
    /// Unacknowledged only.
    pub active: bool,
    /// Exact kind, already validated by the caller.
    pub kind: Option<String>,
    /// Free text, matched case-insensitively against the message and the kind.
    ///
    /// Wanted raw. `search::escape_like` exists because Postgres reads `%` and `_` in a
    /// LIKE pattern as wildcards; there is no pattern here, so escaping first would turn
    /// a search for "50%" into a search for the backslash the escape added.
    pub search: Option<String>,
    pub limit: i64,
    pub offset: i64,
}

impl Filter {
    fn matches(&self, alert: &Alert) -> bool {
        if self.active && alert.acknowledged_at.is_some() {
            return false;
        }

        if let Some(kind) = self.kind.as_deref()
            && kind != alert.kind
        {
            return false;
        }

        self.search.as_deref().is_none_or(|needle| {
            let needle = needle.to_lowercase();

            alert.message.to_lowercase().contains(&needle)
                || alert.kind.to_lowercase().contains(&needle)
        })
    }
}

/// A row with no id, no kind or no timestamp is not an alert anyone can act on: it
/// cannot be acknowledged, it cannot take part in de-duplication, and it has no place in
/// an ordering. Such a row is skipped rather than invented. The rest falls back, on the
/// same reasoning as everywhere else in this store: a hand-edited cell should cost that
/// field and not the row around it.
fn from_row(row: &[String]) -> Option<Alert> {
    Some(Alert {
        id: schema::integer(row, 0)?,
        reading_id: schema::integer(row, 1),
        kind: schema::text(row, 2)?,
        message: schema::text(row, 3).unwrap_or_default(),
        value: schema::number(row, 4).unwrap_or_default(),
        threshold: schema::number(row, 5).unwrap_or_default(),
        created_at: schema::timestamp(row, 6)?,
        acknowledged_at: schema::timestamp(row, 7),
        acknowledged_by: schema::text(row, 8).and_then(|raw| Uuid::parse_str(&raw).ok()),
        response_ms: schema::integer(row, 9),
    })
}

/// `last_notified_at` is the one column the API tracks that the client never sees, which
/// is why it is read on its own rather than hung off the model.
fn last_notified(row: &[String]) -> Option<DateTime<Utc>> {
    schema::timestamp(row, 10)
}

fn to_row(alert: &Alert, last_notified_at: Option<DateTime<Utc>>) -> Vec<String> {
    vec![
        alert.id.to_string(),
        schema::put(alert.reading_id),
        alert.kind.clone(),
        alert.message.clone(),
        alert.value.to_string(),
        alert.threshold.to_string(),
        schema::put_time(alert.created_at),
        alert.acknowledged_at.map(schema::put_time).unwrap_or_default(),
        schema::put(alert.acknowledged_by),
        schema::put(alert.response_ms),
        last_notified_at.map(schema::put_time).unwrap_or_default(),
    ]
}

/// The range covering one alert, addressed by its position in a read of [`RANGE`].
///
/// That read starts at row 2, so index zero is the first row under the header.
fn row_range(index: usize) -> String {
    let row = index + 2;

    format!("alerts!A{row}:K{row}")
}

/// The next id, one past the highest the sheet already holds.
///
/// Postgres handed these out from a sequence, which could not repeat one however many
/// writers arrived at once. There is no sequence here, so the id is read and then
/// written, and two raises that both read before either appends take the same number.
/// Duplicate alerts were accepted for this design, and this is one of the shapes that
/// acceptance takes: the cost is a confusing pair of rows and an acknowledge that
/// resolves whichever of them the scan reaches first, not a lost reading.
fn next_id(rows: &[Vec<String>]) -> i64 {
    rows.iter()
        .filter_map(|row| schema::integer(row, 0))
        .max()
        .unwrap_or(0)
        + 1
}

/// Applies the filter, the ordering and the window that `where`, `order by` and `limit`
/// used to apply, and reports the total the way a separate `count(*)` did.
///
/// Ties break on id so that two alerts raised in the same instant cannot swap places
/// between one page and the next and hand a client the same row twice.
fn window(mut alerts: Vec<Alert>, filter: &Filter) -> (Vec<Alert>, i64) {
    alerts.retain(|alert| filter.matches(alert));
    alerts.sort_by(|left, right| {
        right
            .created_at
            .cmp(&left.created_at)
            .then(right.id.cmp(&left.id))
    });

    let total = i64::try_from(alerts.len()).unwrap_or(i64::MAX);
    let offset = usize::try_from(filter.offset).unwrap_or(0);
    let limit = usize::try_from(filter.limit).unwrap_or(0);

    (alerts.into_iter().skip(offset).take(limit).collect(), total)
}

fn due_for_renotify(last_notified_at: Option<DateTime<Utc>>, now: DateTime<Utc>) -> bool {
    last_notified_at
        .is_none_or(|last| now.signed_duration_since(last).num_seconds() >= RENOTIFY_AFTER_SECONDS)
}

/// Widens an alert into the shape the list endpoint returns, with the measurements left
/// empty.
///
/// In Postgres this was a left join to `readings`. Readings live in month tabs keyed by
/// time, so there is no join to make: a caller that wants the measurements looks up the
/// tab the alert's timestamp points at and fills these in itself, and one that only
/// needs the alert pays nothing.
fn with_reading(alert: Alert) -> AlertWithReading {
    AlertWithReading {
        id: alert.id,
        reading_id: alert.reading_id,
        kind: alert.kind,
        message: alert.message,
        value: alert.value,
        threshold: alert.threshold,
        created_at: alert.created_at,
        acknowledged_at: alert.acknowledged_at,
        acknowledged_by: alert.acknowledged_by,
        response_ms: alert.response_ms,
        voltage_v: None,
        current_a: None,
        temperature_c: None,
        apparent_power_va: None,
        power_w: None,
        power_factor: None,
        frequency_hz: None,
        energy_kwh: None,
    }
}

fn parse(rows: &[Vec<String>]) -> Vec<Alert> {
    rows.iter().filter_map(|row| from_row(row)).collect()
}

/// One page of alerts, newest first, with the total across every match.
///
/// The whole tab comes back and the filtering happens in this process, because a
/// spreadsheet has no `where` to push any of it into. That is affordable only because
/// de-duplication keeps this table to roughly one row per condition rather than one per
/// reading; if that guard ever stops holding, this read grows with it.
pub async fn list(sheets: &Sheets, filter: &Filter) -> AppResult<Page<AlertWithReading>> {
    let rows = sheets.values_cached(RANGE, TTL).await?;
    let (page, total) = window(parse(&rows), filter);

    Ok(Page::new(
        page.into_iter().map(with_reading).collect(),
        total,
        filter.limit,
        filter.offset,
    ))
}

/// How many alerts are still open, for the badge the dashboard shows.
///
/// Served from the same cached read as the list, so a screen showing both costs one
/// request rather than two.
pub async fn count_unacknowledged(sheets: &Sheets) -> AppResult<i64> {
    let rows = sheets.values_cached(RANGE, TTL).await?;
    let open = parse(&rows)
        .iter()
        .filter(|alert| alert.acknowledged_at.is_none())
        .count();

    Ok(i64::try_from(open).unwrap_or(i64::MAX))
}

/// The oldest open alert of a kind, or none.
///
/// This is the de-duplication guard, and it is now only a guard. Postgres backed it with
/// a partial unique index, so a raise that lost the race between this check and the
/// append hit a conflict and stopped. A spreadsheet has no unique index and nothing to
/// conflict with, so two ingests that both find nothing open here will both raise, and
/// one ongoing overload becomes two alerts and two pushes to every device.
///
/// Read uncached on purpose: a stale answer widens exactly the window that produces the
/// duplicate.
pub async fn open_of_kind(sheets: &Sheets, kind: &str) -> AppResult<Option<Alert>> {
    let rows = sheets.values(RANGE).await?;
    let mut open: Vec<Alert> = parse(&rows)
        .into_iter()
        .filter(|alert| alert.kind == kind && alert.acknowledged_at.is_none())
        .collect();

    open.sort_by_key(|alert| alert.created_at);

    Ok(open.into_iter().next())
}

/// Stamps the oldest open alert of a kind as announced, and returns it when it was due.
///
/// Postgres did the finding and the stamping in one statement, under `for update skip
/// locked`, so of two ingests arriving together exactly one could come away holding the
/// alert. Here the read and the write are separate calls with a network round trip in
/// between, so both can see the same alert as due, both stamp it, and both go on to
/// notify. The renotify interval is therefore a floor on how often a phone is told, not
/// a promise that it is told once.
pub async fn claim_renotify(sheets: &Sheets, kind: &str) -> AppResult<Option<Alert>> {
    let now = Utc::now();
    let rows = sheets.values(RANGE).await?;

    let mut due: Vec<(usize, Alert)> = rows
        .iter()
        .enumerate()
        .filter_map(|(index, row)| from_row(row).map(|alert| (index, alert, last_notified(row))))
        .filter(|(_, alert, last)| {
            alert.kind == kind
                && alert.acknowledged_at.is_none()
                && due_for_renotify(*last, now)
        })
        .map(|(index, alert, _)| (index, alert))
        .collect();

    due.sort_by_key(|(_, alert)| alert.created_at);

    let Some((index, alert)) = due.into_iter().next() else {
        return Ok(None);
    };

    sheets
        .update(&row_range(index), vec![to_row(&alert, Some(now))])
        .await?;
    sheets.invalidate(TAB).await;

    Ok(Some(alert))
}

/// Opens a new alert.
///
/// The tab is ensured first because a fresh spreadsheet has no alerts tab until the
/// first threshold is crossed, and the first crossing is the worst moment to fail.
///
/// `last_notified_at` is stamped with the creation time, matching the insert this
/// replaces: an alert has just announced itself by existing, so the renotify clock
/// starts now rather than leaving it due again on the very next reading.
pub async fn insert(
    sheets: &Sheets,
    reading_id: i64,
    kind: &str,
    message: &str,
    value: f64,
    threshold: f64,
) -> AppResult<Alert> {
    sheets.ensure_tab(TAB, ALERTS_HEADER).await?;

    let ids = sheets.values(IDS).await?;
    let now = Utc::now();
    let alert = Alert {
        id: next_id(&ids),
        reading_id: Some(reading_id),
        kind: kind.to_owned(),
        message: message.to_owned(),
        value,
        threshold,
        created_at: now,
        acknowledged_at: None,
        acknowledged_by: None,
        response_ms: None,
    };

    sheets.append(RANGE, vec![to_row(&alert, Some(now))]).await?;
    sheets.invalidate(TAB).await;

    Ok(alert)
}

/// Acknowledges an open alert and records how long the responder took.
///
/// Postgres made this a conditional update: `where acknowledged_at is null` meant the
/// second of two admins pressing the button at the same moment changed nothing and was
/// told the alert was already handled. There is no conditional write in Sheets, so the
/// row is read, edited and written whole, and both writes land. Last writer wins, and
/// the name and response time that survive are the ones that arrived second rather than
/// the ones that belong to whoever actually responded first.
///
/// A missing alert and an already acknowledged one are both [`AppError::NotFound`],
/// which is what the conditional update reported for either.
pub async fn acknowledge(sheets: &Sheets, id: i64, responder: Uuid) -> AppResult<Alert> {
    let rows = sheets.values(RANGE).await?;

    let (index, mut alert, last) = rows
        .iter()
        .enumerate()
        .filter_map(|(index, row)| from_row(row).map(|alert| (index, alert, last_notified(row))))
        .find(|(_, alert, _)| alert.id == id)
        .ok_or(AppError::NotFound)?;

    if alert.acknowledged_at.is_some() {
        return Err(AppError::NotFound);
    }

    let now = Utc::now();
    alert.acknowledged_at = Some(now);
    alert.acknowledged_by = Some(responder);
    alert.response_ms = Some(now.signed_duration_since(alert.created_at).num_milliseconds());

    sheets
        .update(&row_range(index), vec![to_row(&alert, last)])
        .await?;
    sheets.invalidate(TAB).await;

    Ok(alert)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn row(values: &[&str]) -> Vec<String> {
        values.iter().map(|value| (*value).to_owned()).collect()
    }

    fn at(rfc3339: &str) -> DateTime<Utc> {
        DateTime::parse_from_rfc3339(rfc3339)
            .expect("test timestamp")
            .with_timezone(&Utc)
    }

    fn alert(id: i64, kind: &str, message: &str, created_at: &str) -> Alert {
        Alert {
            id,
            reading_id: Some(id),
            kind: kind.to_owned(),
            message: message.to_owned(),
            value: 940.0,
            threshold: 900.0,
            created_at: at(created_at),
            acknowledged_at: None,
            acknowledged_by: None,
            response_ms: None,
        }
    }

    fn everything() -> Filter {
        Filter {
            active: false,
            kind: None,
            search: None,
            limit: 20,
            offset: 0,
        }
    }

    #[test]
    fn an_acknowledged_alert_reads_back_as_written() {
        let responder = Uuid::new_v4();
        let mut original = alert(7, "overload", "Load reached 940 VA", "2026-08-14T09:00:00Z");
        original.acknowledged_at = Some(at("2026-08-14T09:02:00Z"));
        original.acknowledged_by = Some(responder);
        original.response_ms = Some(120_000);
        let notified = at("2026-08-14T09:01:00Z");

        let cells = to_row(&original, Some(notified));
        let round_tripped = from_row(&cells).expect("a written row reads back");

        assert_eq!(round_tripped.id, 7);
        assert_eq!(round_tripped.kind, "overload");
        assert_eq!(round_tripped.value, 940.0);
        assert_eq!(round_tripped.acknowledged_by, Some(responder));
        assert_eq!(round_tripped.response_ms, Some(120_000));
        assert_eq!(last_notified(&cells), Some(notified));
    }

    #[test]
    fn an_open_alert_leaves_its_unset_columns_blank() {
        // Where Postgres held nulls the sheet holds empty cells, and they have to read
        // back as absence rather than as an acknowledgement nobody made.
        let cells = to_row(&alert(1, "overload", "Load reached 940 VA", "2026-08-14T09:00:00Z"), None);
        let parsed = from_row(&cells).expect("an open alert is still an alert");

        assert_eq!(cells[7], "");
        assert_eq!(cells[8], "");
        assert_eq!(parsed.acknowledged_at, None);
        assert_eq!(parsed.acknowledged_by, None);
        assert_eq!(last_notified(&cells), None);
    }

    #[test]
    fn a_row_without_an_id_is_skipped_rather_than_read_as_an_alert() {
        let orphan = row(&["", "3", "overload", "Load reached 940 VA", "940", "900", "2026-08-14T09:00:00Z"]);

        assert!(from_row(&orphan).is_none());
    }

    #[test]
    fn a_row_whose_creation_time_was_cleared_is_skipped() {
        let undated = row(&["4", "3", "overload", "Load reached 940 VA", "940", "900", ""]);

        assert!(from_row(&undated).is_none());
    }

    #[test]
    fn the_first_alert_in_an_empty_sheet_takes_id_one() {
        assert_eq!(next_id(&[]), 1);
    }

    #[test]
    fn the_next_id_is_one_past_the_highest_even_when_the_rows_are_out_of_order() {
        let existing = vec![row(&["3"]), row(&["9"]), row(&["4"])];

        assert_eq!(next_id(&existing), 10);
    }

    #[test]
    fn two_raises_racing_can_take_the_same_id() {
        // Both read before either appends, so both see the same sheet and derive the
        // same number. This is the accepted duplicate, written down as a test so nobody
        // later mistakes it for a bug in the derivation.
        let sheet = vec![row(&["1"]), row(&["2"])];

        let first = next_id(&sheet);
        let second = next_id(&sheet);

        assert_eq!(first, 3);
        assert_eq!(second, 3);
    }

    #[test]
    fn a_hand_typed_id_that_is_not_a_number_does_not_stall_the_next_one() {
        let damaged = vec![row(&["1"]), row(&["two"]), row(&["5"])];

        assert_eq!(next_id(&damaged), 6);
    }

    #[test]
    fn the_active_filter_hides_acknowledged_alerts() {
        let mut handled = alert(1, "overload", "Load reached 940 VA", "2026-08-14T09:00:00Z");
        handled.acknowledged_at = Some(at("2026-08-14T09:05:00Z"));
        let open = alert(2, "overload", "Load reached 950 VA", "2026-08-14T09:10:00Z");

        let filter = Filter {
            active: true,
            ..everything()
        };
        let (page, total) = window(vec![handled, open], &filter);

        assert_eq!(total, 1);
        assert_eq!(page[0].id, 2);
    }

    #[test]
    fn a_kind_filter_matches_exactly_rather_than_by_substring() {
        let filter = Filter {
            kind: Some("temperature".to_owned()),
            ..everything()
        };

        assert!(filter.matches(&alert(1, "temperature", "Temperature reached 41.0 C", "2026-08-14T09:00:00Z")));
        assert!(!filter.matches(&alert(2, "temp", "Temperature reached 41.0 C", "2026-08-14T09:00:00Z")));
    }

    #[test]
    fn a_search_matches_the_message_or_the_kind_whatever_the_case() {
        let by_message = Filter {
            search: Some("REACHED".to_owned()),
            ..everything()
        };
        let by_kind = Filter {
            search: Some("Over".to_owned()),
            ..everything()
        };
        let by_neither = Filter {
            search: Some("relay".to_owned()),
            ..everything()
        };
        let subject = alert(1, "overload", "Load reached 940 VA", "2026-08-14T09:00:00Z");

        assert!(by_message.matches(&subject));
        assert!(by_kind.matches(&subject));
        assert!(!by_neither.matches(&subject));
    }

    #[test]
    fn the_total_counts_every_match_and_not_just_the_page() {
        let alerts = (1..=5)
            .map(|id| alert(id, "overload", "Load reached 940 VA", "2026-08-14T09:00:00Z"))
            .collect();

        let filter = Filter {
            limit: 2,
            ..everything()
        };
        let (page, total) = window(alerts, &filter);

        assert_eq!(page.len(), 2);
        assert_eq!(total, 5);
    }

    #[test]
    fn the_newest_alert_comes_first_and_ties_break_on_id() {
        let alerts = vec![
            alert(1, "overload", "first", "2026-08-14T09:00:00Z"),
            alert(2, "overload", "same instant", "2026-08-14T09:30:00Z"),
            alert(3, "overload", "same instant", "2026-08-14T09:30:00Z"),
        ];

        let (page, _) = window(alerts, &everything());

        assert_eq!(
            page.iter().map(|alert| alert.id).collect::<Vec<_>>(),
            vec![3, 2, 1]
        );
    }

    #[test]
    fn a_page_past_the_end_is_empty_without_losing_the_total() {
        let alerts = vec![alert(1, "overload", "Load reached 940 VA", "2026-08-14T09:00:00Z")];

        let filter = Filter {
            offset: 50,
            ..everything()
        };
        let (page, total) = window(alerts, &filter);

        assert!(page.is_empty());
        assert_eq!(total, 1);
    }

    #[test]
    fn an_alert_that_has_never_been_announced_is_due_at_once() {
        assert!(due_for_renotify(None, at("2026-08-14T09:00:00Z")));
    }

    #[test]
    fn an_alert_announced_within_the_last_minute_is_not_due_again() {
        let announced = at("2026-08-14T09:00:00Z");

        assert!(!due_for_renotify(Some(announced), at("2026-08-14T09:00:59Z")));
        assert!(due_for_renotify(Some(announced), at("2026-08-14T09:01:00Z")));
    }

    #[test]
    fn a_row_is_addressed_under_the_header_rather_than_over_it() {
        assert_eq!(row_range(0), "alerts!A2:K2");
        assert_eq!(row_range(4), "alerts!A6:K6");
    }

    #[test]
    fn a_listed_alert_carries_no_measurements_until_a_caller_adds_them() {
        let widened = with_reading(alert(1, "overload", "Load reached 940 VA", "2026-08-14T09:00:00Z"));

        assert_eq!(widened.id, 1);
        assert_eq!(widened.reading_id, Some(1));
        assert_eq!(widened.voltage_v, None);
        assert_eq!(widened.temperature_c, None);
    }
}
