use std::time::Duration;

use chrono::{DateTime, Utc};

use crate::device::model::Heartbeat;
use crate::error::AppResult;
use crate::sheets::schema::{self, DEVICE_HEADER};
use crate::sheets::Sheets;

const TAB: &str = "device_telemetry";
/// The single row, under the header.
const ROW: &str = "device_telemetry!A2:J2";
/// The relay command on its own, so queueing one does not rewrite the telemetry beside it.
const COMMAND_CELL: &str = "device_telemetry!H2";

/// The board reports every few seconds and the dashboard asks for its state about as
/// often.
///
/// Five seconds, shorter than the settings window, because the moving fields here are
/// signal strength and uptime and a panel that never changes looks broken. Long enough
/// that a dashboard polling once a second costs one read rather than five.
const TTL: Duration = Duration::from_secs(5);

/// What the firmware has told us about itself.
///
/// Distinct from `DeviceStatus`, which the service builds from this plus the newest
/// hardware reading. Connection is not in here: a board can leave stale telemetry behind
/// and be off, so whether it is alive is decided by when a reading last landed.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct Telemetry {
    pub device_id: Option<String>,
    pub firmware: Option<String>,
    pub ssid: Option<String>,
    pub ip_address: Option<String>,
    pub signal_dbm: Option<i32>,
    pub uptime_seconds: Option<i64>,
    /// What an admin has asked the relay to do, waiting for the next heartbeat.
    pub relay_command: Option<String>,
    pub relay_locked_out: bool,
    pub reported_at: Option<DateTime<Utc>>,
}

fn from_row(row: &[String]) -> Telemetry {
    Telemetry {
        device_id: schema::text(row, 1),
        firmware: schema::text(row, 2),
        ssid: schema::text(row, 3),
        ip_address: schema::text(row, 4),
        signal_dbm: schema::integer(row, 5).and_then(|value| i32::try_from(value).ok()),
        uptime_seconds: schema::integer(row, 6),
        relay_command: schema::text(row, 7),
        // A blank lockout cell is a board that has never said, which is not the same as a
        // board that is locked out. False is the safer reading of silence: it claims
        // nothing, where true would show the load deliberately cut when nobody cut it.
        relay_locked_out: schema::flag(row, 8).unwrap_or(false),
        reported_at: schema::timestamp(row, 9),
    }
}

fn to_row(telemetry: &Telemetry) -> Vec<String> {
    vec![
        "1".to_owned(),
        schema::put(telemetry.device_id.as_deref()),
        schema::put(telemetry.firmware.as_deref()),
        schema::put(telemetry.ssid.as_deref()),
        schema::put(telemetry.ip_address.as_deref()),
        schema::put(telemetry.signal_dbm),
        schema::put(telemetry.uptime_seconds),
        schema::put(telemetry.relay_command.as_deref()),
        telemetry.relay_locked_out.to_string(),
        telemetry.reported_at.map(schema::put_time).unwrap_or_default(),
    ]
}

/// Lays a heartbeat over the stored row.
///
/// This is the `coalesce` the UPDATE used to do. The firmware sends only what it knows,
/// and it knows different things at different times: an absent field has to keep the
/// stored value rather than blank it, or a board that reports its uptime without its SSID
/// would erase the network it is on.
///
/// Takes the clock as an argument so the merge can be tested for what it keeps rather
/// than for when it ran.
fn merged(current: &Telemetry, heartbeat: &Heartbeat, now: DateTime<Utc>) -> Telemetry {
    Telemetry {
        device_id: heartbeat
            .device_id
            .as_ref()
            .or(current.device_id.as_ref())
            .cloned(),
        firmware: heartbeat
            .firmware
            .as_ref()
            .or(current.firmware.as_ref())
            .cloned(),
        ssid: heartbeat.ssid.as_ref().or(current.ssid.as_ref()).cloned(),
        ip_address: heartbeat
            .ip_address
            .as_ref()
            .or(current.ip_address.as_ref())
            .cloned(),
        signal_dbm: heartbeat.signal_dbm.or(current.signal_dbm),
        uptime_seconds: heartbeat.uptime_seconds.or(current.uptime_seconds),
        // The row being written must not still hold the command that is about to be handed
        // back. One that stayed set would be delivered again on the next beat and undo
        // whatever the protection decided in between.
        relay_command: None,
        relay_locked_out: heartbeat.relay_locked_out.unwrap_or(current.relay_locked_out),
        reported_at: Some(now),
    }
}

/// The stored row, read past the cache.
///
/// A write here is a read then a write, and merging into a row that is seconds old would
/// restore fields a heartbeat has already changed. Every writer pays a fresh read.
async fn current(sheets: &Sheets) -> AppResult<Telemetry> {
    let rows = sheets.values(ROW).await?;

    Ok(rows.first().map_or_else(Telemetry::default, |row| from_row(row)))
}

/// The board's self-reported state, all absent when it has never reported.
///
/// Absence rather than an error, because a spreadsheet that nobody has written to is the
/// normal state of a fresh deployment and the status screen has something to show either
/// way: it reports the board as disconnected, which is true.
pub async fn load(sheets: &Sheets) -> AppResult<Telemetry> {
    let rows = sheets.values_cached(ROW, TTL).await?;

    Ok(rows.first().map_or_else(Telemetry::default, |row| from_row(row)))
}

/// Records a heartbeat and hands back whatever relay command was waiting.
///
/// Postgres did this as one `update ... returning`, which made the handover atomic: the
/// command was read and cleared in the same statement, so exactly one heartbeat could
/// ever receive it. Here it is a read and then a write, and two heartbeats arriving
/// together can both see the same command and both act on it.
///
/// That is accepted rather than worked around. A relay command is a level and not a
/// pulse: the firmware applies "open" to a relay that is already open and nothing moves,
/// so a repeated command is harmless where a lost one would leave an operator pressing a
/// button that does nothing.
///
/// The whole row goes in one call. A per-cell write would cost a request each and could
/// interleave with another writer to leave a row that is half one heartbeat and half the
/// next.
pub async fn record_heartbeat(
    sheets: &Sheets,
    heartbeat: &Heartbeat,
) -> AppResult<Option<String>> {
    sheets.ensure_tab(TAB, DEVICE_HEADER).await?;

    let stored = current(sheets).await?;
    let next = merged(&stored, heartbeat, Utc::now());

    sheets.update(ROW, vec![to_row(&next)]).await?;
    sheets.invalidate(TAB).await;

    Ok(stored.relay_command)
}

/// Queues a relay command for the board's next heartbeat.
///
/// Overwrites anything still pending rather than queueing behind it. Someone who pressed
/// open and then close means close: replaying the first would leave the relay in the state
/// they changed their mind about.
///
/// Writes the one cell rather than the row, which costs a single call and cannot overwrite
/// telemetry with a copy read a moment earlier. It does not survive the other order: a
/// heartbeat rewrites the whole row with the command cleared, so one queued in the instant
/// between that heartbeat's read and its write is erased before any board sees it. Postgres
/// serialized those two writes and a spreadsheet cannot. The recovery is the one an
/// operator standing in front of the relay would reach for anyway, which is to press again.
pub async fn request_relay_command(sheets: &Sheets, command: &str) -> AppResult<()> {
    sheets.ensure_tab(TAB, DEVICE_HEADER).await?;
    sheets
        .update(COMMAND_CELL, vec![vec![command.to_owned()]])
        .await?;
    sheets.invalidate(TAB).await;

    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn row(values: &[&str]) -> Vec<String> {
        values.iter().map(|value| (*value).to_owned()).collect()
    }

    fn at(raw: &str) -> DateTime<Utc> {
        DateTime::parse_from_rfc3339(raw)
            .expect("the test timestamp should be valid")
            .with_timezone(&Utc)
    }

    fn stored() -> Telemetry {
        Telemetry {
            device_id: Some("dynavolt-01".to_owned()),
            firmware: Some("1.4.2".to_owned()),
            ssid: Some("workshop".to_owned()),
            ip_address: Some("192.168.1.40".to_owned()),
            signal_dbm: Some(-58),
            uptime_seconds: Some(86_400),
            relay_command: None,
            relay_locked_out: false,
            reported_at: Some(at("2026-08-14T02:30:00Z")),
        }
    }

    fn silent_heartbeat() -> Heartbeat {
        Heartbeat {
            device_id: None,
            firmware: None,
            ssid: None,
            ip_address: None,
            signal_dbm: None,
            uptime_seconds: None,
            relay_locked_out: None,
        }
    }

    #[test]
    fn a_full_row_reads_back_as_written() {
        let mut original = stored();
        original.relay_command = Some("open".to_owned());
        original.relay_locked_out = true;

        assert_eq!(from_row(&to_row(&original)), original);
    }

    #[test]
    fn a_board_that_has_never_reported_reads_as_absent_rather_than_zero() {
        // A signal of zero dBm is a perfect connection, which is the opposite of what an
        // empty cell means. Every identity field has to come back missing instead.
        let telemetry = from_row(&row(&["1"]));

        assert_eq!(telemetry.device_id, None);
        assert_eq!(telemetry.signal_dbm, None);
        assert_eq!(telemetry.uptime_seconds, None);
        assert!(!telemetry.relay_locked_out);
    }

    #[test]
    fn a_partial_heartbeat_leaves_the_fields_it_omits_alone() {
        let mut heartbeat = silent_heartbeat();
        heartbeat.signal_dbm = Some(-71);
        heartbeat.uptime_seconds = Some(90_000);

        let next = merged(&stored(), &heartbeat, at("2026-08-14T02:31:00Z"));

        assert_eq!(next.signal_dbm, Some(-71));
        assert_eq!(next.uptime_seconds, Some(90_000));
        assert_eq!(next.ssid, Some("workshop".to_owned()));
        assert_eq!(next.ip_address, Some("192.168.1.40".to_owned()));
        assert_eq!(next.firmware, Some("1.4.2".to_owned()));
        assert_eq!(next.device_id, Some("dynavolt-01".to_owned()));
    }

    #[test]
    fn a_heartbeat_that_says_nothing_about_the_lockout_leaves_it_set() {
        // Older firmware does not send the field at all. Reading its silence as false
        // would show the load as live while the relay is open and staying open.
        let mut locked_out = stored();
        locked_out.relay_locked_out = true;

        let next = merged(&locked_out, &silent_heartbeat(), at("2026-08-14T02:31:00Z"));

        assert!(next.relay_locked_out);
    }

    #[test]
    fn a_heartbeat_takes_the_pending_command_with_it() {
        let mut waiting = stored();
        waiting.relay_command = Some("close".to_owned());

        let next = merged(&waiting, &silent_heartbeat(), at("2026-08-14T02:31:00Z"));

        assert_eq!(next.relay_command, None);
    }

    #[test]
    fn a_heartbeat_moves_the_reported_time_forward() {
        let beat_at = at("2026-08-14T02:31:00Z");
        let next = merged(&stored(), &silent_heartbeat(), beat_at);

        assert_eq!(next.reported_at, Some(beat_at));
    }
}
