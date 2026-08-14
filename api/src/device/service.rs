use chrono::{DateTime, Utc};
use libsql::{Connection, TransactionBehavior, params};

use crate::device::model::{DeviceStatus, Heartbeat, HeartbeatAck};
use crate::error::{AppError, AppResult};
use crate::readings::service as readings_service;
use crate::settings::service as settings_service;
use crate::time::local_label;

type Telemetry = (
    Option<String>,
    Option<String>,
    Option<String>,
    Option<String>,
    Option<i32>,
    Option<i64>,
    bool,
);

/// Records a firmware heartbeat into the singleton telemetry row, then returns the
/// current alarm thresholds so the board can adopt any operator change. Absent fields
/// coalesce to the stored value, so a partial heartbeat never clears what it omits.
pub async fn record_heartbeat(conn: &Connection, heartbeat: &Heartbeat) -> AppResult<HeartbeatAck> {
    // The pending command is read and cleared inside one transaction, which is what makes
    // the handover exactly once: no window exists in which a second heartbeat could see a
    // command the first has already been given. The Sheets version could not do this. A
    // spreadsheet has no read-and-write statement, so it read the row and then wrote it
    // back, and two heartbeats arriving together could both take the same command away
    // with them.
    //
    // Postgres did it in a single statement, reading the command out of a `for update`
    // snapshot because `returning` reports the row as it is after the update. SQLite has no
    // `for update` and its `returning` is post-update too, so there is no single statement
    // that both clears the command and reports it. All three candidates were tried against
    // SQLite 3.50 with a command waiting, and all three returned null while clearing the
    // row: `returning relay_command`, `returning (select relay_command from
    // device_telemetry where id = 1)`, and the same read hoisted into a `materialized` CTE.
    // The subquery forms are accepted rather than rejected, which is the trap: they compile,
    // they clear the command, and the board is never told what it was.
    //
    // Two statements in a transaction is therefore the shape, and `begin immediate` is the
    // part that replaces `for update`: it takes the write lock up front rather than on the
    // first write, so a second heartbeat cannot begin until this one commits, and it then
    // reads the row this one already cleared. It gets null, so the command reaches the board
    // exactly once. A deferred transaction would let both read the command before either
    // wrote, and the loser would fail its write rather than read a stale value, which is
    // still safe but turns a routine heartbeat into an error.
    let transaction = conn
        .transaction_with_behavior(TransactionBehavior::Immediate)
        .await?;

    let relay_command: Option<String> = {
        let mut rows = transaction
            .query(
                "select relay_command from device_telemetry where id = 1",
                (),
            )
            .await?;

        match rows.next().await? {
            Some(row) => row.get(0)?,
            None => None,
        }
    };

    transaction
        .execute(
            "update device_telemetry set
                 device_id = coalesce(?, device_id),
                 firmware = coalesce(?, firmware),
                 ssid = coalesce(?, ssid),
                 ip_address = coalesce(?, ip_address),
                 signal_dbm = coalesce(?, signal_dbm),
                 uptime_seconds = coalesce(?, uptime_seconds),
                 relay_locked_out = coalesce(?, relay_locked_out),
                 relay_command = null,
                 reported_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
             where id = 1",
            params![
                heartbeat.device_id.as_deref(),
                heartbeat.firmware.as_deref(),
                heartbeat.ssid.as_deref(),
                heartbeat.ip_address.as_deref(),
                heartbeat.signal_dbm,
                heartbeat.uptime_seconds,
                heartbeat.relay_locked_out,
            ],
        )
        .await?;

    transaction.commit().await?;

    let settings = settings_service::load(conn).await?;

    Ok(HeartbeatAck {
        load_threshold_va: settings.load_threshold_va,
        trip_threshold_va: settings.trip_threshold_va,
        temp_threshold_c: settings.temp_threshold_c,
        reclose_delay_seconds: settings.reclose_delay_seconds,
        relay_command,
    })
}

/// Queues an operator's relay command for the board's next heartbeat.
///
/// Overwrites anything still pending rather than queueing behind it. Someone who
/// pressed open and then close means close: replaying the first would leave the relay
/// in the state they changed their mind about.
pub async fn request_relay_command(conn: &Connection, command: &str) -> AppResult<()> {
    conn.execute(
        "update device_telemetry set relay_command = ? where id = 1",
        params![command],
    )
    .await?;

    Ok(())
}

/// Live link state. The identity fields come from the newest reported telemetry and
/// are null until the firmware has reported in; `connected` and the last-seen fields
/// are driven by the newest hardware reading; `simulated` follows the source mode.
pub async fn status(conn: &Connection) -> AppResult<DeviceStatus> {
    let mut rows = conn
        .query(
            "select device_id, firmware, ssid, ip_address, signal_dbm, uptime_seconds,
                    relay_locked_out
             from device_telemetry where id = 1",
            (),
        )
        .await?;

    // `relay_locked_out` is an integer here, and `bool` reads 0 and 1 back for us.
    let telemetry: Telemetry = match rows.next().await? {
        Some(row) => (
            row.get(0)?,
            row.get(1)?,
            row.get(2)?,
            row.get(3)?,
            row.get(4)?,
            row.get(5)?,
            row.get(6)?,
        ),
        None => (None, None, None, None, None, None, false),
    };
    let (device_id, firmware, ssid, ip_address, signal_dbm, uptime_seconds, relay_locked_out) =
        telemetry;

    let settings = settings_service::load(conn).await?;
    let now = Utc::now();

    // Position and last-seen are read out of the one row so they describe the same
    // instant. Asking for the reading twice could straddle an incoming sample and report
    // a relay position that never went with the time shown beside it.
    let mut rows = conn
        .query(
            "select recorded_at, relay_closed
             from readings where source = 'hardware' order by recorded_at desc limit 1",
            (),
        )
        .await?;

    let latest_hardware: Option<(DateTime<Utc>, Option<bool>)> = match rows.next().await? {
        Some(row) => Some((parse_timestamp(&row.get::<String>(0)?)?, row.get(1)?)),
        None => None,
    };

    let connected = latest_hardware.is_some_and(|(recorded_at, _)| {
        readings_service::is_within_connected_window(recorded_at, now)
    });
    let (last_seen_at, last_seen_label, relay_closed) = match latest_hardware {
        Some((recorded_at, relay_closed)) => (
            Some(recorded_at),
            Some(local_label(recorded_at)),
            relay_closed,
        ),
        None => (None, None, None),
    };

    Ok(DeviceStatus {
        connected,
        relay_locked_out,
        relay_closed,
        device_id,
        firmware,
        ip_address,
        signal_dbm,
        uptime_seconds,
        ssid,
        last_seen_at,
        last_seen_label,
        simulated: settings.source_mode != "hardware",
    })
}

/// Timestamps are text in this database, so every read parses.
///
/// Strict on purpose: an unparseable `recorded_at` silently replaced by `Utc::now()`
/// would report a dead board as connected, which is the one thing this screen exists to
/// tell an operator.
fn parse_timestamp(raw: &str) -> AppResult<DateTime<Utc>> {
    DateTime::parse_from_rfc3339(raw)
        .map(|at| at.with_timezone(&Utc))
        .map_err(|error| AppError::Upstream(format!("unreadable timestamp {raw:?}: {error}")))
}
