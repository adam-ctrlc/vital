package device

// Transaction control for the relay handover. Sent as statements on one dedicated
// connection rather than through database/sql's BeginTx, because BeginTx can only
// say BEGIN, and the handover needs BEGIN IMMEDIATE (see Store.handover).
const (
	sqlBeginImmediate = "begin immediate"
	sqlCommit         = "commit"
	sqlRollback       = "rollback"
)

// sqlSelectRelayCommand reads the pending command, its id and when it was requested,
// inside the handover transaction.
const sqlSelectRelayCommand = `select relay_command, relay_command_id, relay_command_at
from device_telemetry where id = 1`

// sqlRecordHeartbeat stores a heartbeat. Absent fields arrive as NULL and coalesce to
// the stored value, so a partial heartbeat never clears what it omits. The pending
// command is left to the handover. Parameters are Heartbeat.args.
const sqlRecordHeartbeat = `update device_telemetry set
    device_id = coalesce(?1, device_id),
    firmware = coalesce(?2, firmware),
    ssid = coalesce(?3, ssid),
    ip_address = coalesce(?4, ip_address),
    signal_dbm = coalesce(?5, signal_dbm),
    uptime_seconds = coalesce(?6, uptime_seconds),
    relay_locked_out = coalesce(?7, relay_locked_out),
    reset_reason = coalesce(?8, reset_reason),
    reported_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
where id = 1`

// sqlClearRelayCommand clears the pending command once the handover decides it is
// done with: delivered to firmware that does not acknowledge, acknowledged, or expired.
const sqlClearRelayCommand = `update device_telemetry set relay_command = null where id = 1`

// sqlRequestRelayCommand queues an operator's command, replacing anything pending, under
// the next id. ?2 is the request time in the stored shape.
const sqlRequestRelayCommand = `update device_telemetry
set relay_command = ?1, relay_command_id = relay_command_id + 1, relay_command_at = ?2
where id = 1`

// sqlSelectTelemetry reads the identity and link telemetry for the status screen.
// relay_locked_out is an integer 0 or 1.
const sqlSelectTelemetry = `select device_id, firmware, ssid, ip_address, signal_dbm, uptime_seconds,
       relay_locked_out, reset_reason
from device_telemetry where id = 1`

// sqlSelectLatestHardware reads position and time out of the one newest hardware
// row, so they describe the same instant.
const sqlSelectLatestHardware = `select recorded_at, relay_closed
from readings where source = 'hardware' order by recorded_at desc limit 1`
