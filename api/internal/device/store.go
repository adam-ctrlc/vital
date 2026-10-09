package device

import (
	"context"
	"database/sql"
	"errors"
	"fmt"
	"time"

	"github.com/adam-ctrlc/vital/api/internal/wire"
)

// ErrUnreadableTimestamp means a stored recorded_at would not parse. The Rust API
// answered it with a 502 rather than guessing: an unparseable time silently read
// as "now" would report a dead board as connected, which is the one thing the
// status screen exists to tell an operator.
var ErrUnreadableTimestamp = errors.New("unreadable timestamp")

// Store reads and writes the device_telemetry row and the newest hardware reading.
//
// The relay handover needs a dedicated connection (sql.DB.Conn), because its
// transaction is driven statement by statement.
type Store struct {
	db *sql.DB
}

// NewStore returns a Store over conn, the *sql.DB from db.Open.
func NewStore(conn *sql.DB) *Store {
	return &Store{db: conn}
}

// CommandLifetime is how long a relay command waits for the board. One older than
// this is dropped rather than delivered: a board that was away for longer comes back
// to a situation the operator has stopped watching, and should not act on it.
const CommandLifetime = 60 * time.Second

// RecordHeartbeat stores a heartbeat into the singleton telemetry row and hands over
// the pending relay command, if any, in the same transaction (see handover).
//
// Load the thresholds for the ack before calling this, not after: for firmware that
// does not acknowledge, the command is cleared as it is handed over, so a failure
// afterwards would lose it.
func (s *Store) RecordHeartbeat(ctx context.Context, hb Heartbeat, now time.Time) (Pending, error) {
	p, err := s.handover(ctx, hb.RelayCommandAck, now, sqlRecordHeartbeat, hb.args()...)
	if err != nil {
		return Pending{}, fmt.Errorf("record heartbeat: %w", err)
	}
	return p, nil
}

// RelayHandover hands over the pending relay command for the reading ingest, by the
// same rules as the heartbeat. ack is the body's relayCommandAck, nil when absent.
//
// The command rides back on the reading the board already posts every few seconds,
// rather than needing a heartbeat of its own. Radio time is the scarcest thing on
// that board.
func (s *Store) RelayHandover(ctx context.Context, ack *int64, now time.Time) (Pending, error) {
	p, err := s.handover(ctx, ack, now, "")
	if err != nil {
		return Pending{}, fmt.Errorf("hand over relay command: %w", err)
	}
	return p, nil
}

// handover runs write (if any), reads the pending command and decides what to hand
// over. No transaction: over Turso's HTTP protocol a dedicated connection's stream can
// already be closed when BEGIN arrives, and nothing then reaches the board. Each step is
// one statement on the pool instead, which reconnects by itself.
//
// The clear only matches the command id that was read, so a command queued in between
// survives, and when two requests race for a take-once command only the one whose clear
// lands delivers it.
func (s *Store) handover(ctx context.Context, ack *int64, now time.Time, write string, args ...any) (Pending, error) {
	if write != "" {
		if _, err := s.db.ExecContext(ctx, write, args...); err != nil {
			return Pending{}, fmt.Errorf("write: %w", err)
		}
	}

	var (
		command     sql.NullString
		id          sql.NullInt64
		requestedAt sql.NullString
	)
	err := s.db.QueryRowContext(ctx, sqlSelectRelayCommand).Scan(&command, &id, &requestedAt)
	if err != nil && !errors.Is(err, sql.ErrNoRows) {
		return Pending{}, fmt.Errorf("read pending relay command: %w", err)
	}
	pending := Pending{Command: Command(command.String), ID: id.Int64}

	deliver, clear := decideHandover(pending, requestedAt, ack, now)
	if !clear {
		return deliver, nil
	}
	res, err := s.db.ExecContext(ctx, sqlClearRelayCommand, pending.ID)
	if err != nil {
		return Pending{}, fmt.Errorf("clear pending relay command: %w", err)
	}
	if n, err := res.RowsAffected(); err != nil {
		return Pending{}, fmt.Errorf("clear pending relay command: %w", err)
	} else if n == 0 {
		return Pending{}, nil
	}
	return deliver, nil
}

// decideHandover is handover's rule, apart from the database: what to hand over and
// whether to clear the row.
func decideHandover(pending Pending, requestedAt sql.NullString, ack *int64, now time.Time) (deliver Pending, clear bool) {
	if pending.Command == CommandNone {
		return Pending{}, false
	}
	if expired(requestedAt, now) {
		return Pending{}, true
	}
	if ack == nil {
		return pending, true
	}
	if pending.ID <= *ack {
		return Pending{}, true
	}
	return pending, false
}

// expired reports whether a command requested at requestedAt has outlived
// CommandLifetime. One with no time was queued by the API from before 0024 and is
// delivered; one whose time will not parse is of unknown age and is dropped, the
// safer of the two for something that moves the contacts.
func expired(requestedAt sql.NullString, now time.Time) bool {
	if !requestedAt.Valid {
		return false
	}
	at, err := wire.ParseTime(requestedAt.String)
	if err != nil {
		return true
	}
	return now.Sub(at) > CommandLifetime
}

// RequestRelayCommand queues an operator's relay command for whichever request
// the board makes next.
//
// It overwrites anything still pending rather than queueing behind it. Someone who
// pressed open and then close means close: replaying the first would leave the
// relay in the state they changed their mind about.
func (s *Store) RequestRelayCommand(ctx context.Context, cmd Command, now time.Time) error {
	if _, err := s.db.ExecContext(ctx, sqlRequestRelayCommand, string(cmd), wire.FormatStorage(now)); err != nil {
		return fmt.Errorf("queue relay command %q: %w", cmd, err)
	}
	return nil
}

// Telemetry reads what the firmware last reported. A missing row reads as nothing
// reported yet rather than an error.
func (s *Store) Telemetry(ctx context.Context) (Telemetry, error) {
	var (
		deviceID, firmware, ssid, ipAddress sql.NullString
		resetReason                         sql.NullString
		signalDBm                           sql.NullInt32
		uptimeSeconds                       sql.NullInt64
		t                                   Telemetry
	)
	err := s.db.QueryRowContext(ctx, sqlSelectTelemetry).Scan(
		&deviceID, &firmware, &ssid, &ipAddress, &signalDBm, &uptimeSeconds, &t.RelayLockedOut, &resetReason,
	)
	switch {
	case errors.Is(err, sql.ErrNoRows):
		return Telemetry{}, nil
	case err != nil:
		return Telemetry{}, fmt.Errorf("read device telemetry: %w", err)
	}

	t.DeviceID = ptrIf(deviceID.String, deviceID.Valid)
	t.Firmware = ptrIf(firmware.String, firmware.Valid)
	t.SSID = ptrIf(ssid.String, ssid.Valid)
	t.IPAddress = ptrIf(ipAddress.String, ipAddress.Valid)
	t.SignalDBm = ptrIf(signalDBm.Int32, signalDBm.Valid)
	t.UptimeSeconds = ptrIf(uptimeSeconds.Int64, uptimeSeconds.Valid)
	t.ResetReason = ptrIf(resetReason.String, resetReason.Valid)
	return t, nil
}

// LatestHardware reads the newest hardware reading, or nil if there has never been
// one. An unparseable timestamp is an error wrapping ErrUnreadableTimestamp.
func (s *Store) LatestHardware(ctx context.Context) (*HardwareSample, error) {
	var (
		recordedAt  string
		relayClosed sql.NullBool
	)
	err := s.db.QueryRowContext(ctx, sqlSelectLatestHardware).Scan(&recordedAt, &relayClosed)
	switch {
	case errors.Is(err, sql.ErrNoRows):
		return nil, nil
	case err != nil:
		return nil, fmt.Errorf("read latest hardware reading: %w", err)
	}

	at, err := wire.ParseTime(recordedAt)
	if err != nil {
		return nil, fmt.Errorf("%w: %w", ErrUnreadableTimestamp, err)
	}

	return &HardwareSample{
		RecordedAt:  at,
		RelayClosed: ptrIf(relayClosed.Bool, relayClosed.Valid),
	}, nil
}

// Status reads the telemetry and the newest hardware reading and builds the link
// state as of now. sourceMode is the settings row's source_mode.
func (s *Store) Status(ctx context.Context, sourceMode string, now time.Time) (Status, error) {
	t, err := s.Telemetry(ctx)
	if err != nil {
		return Status{}, err
	}
	latest, err := s.LatestHardware(ctx)
	if err != nil {
		return Status{}, err
	}
	return BuildStatus(t, latest, sourceMode, now), nil
}

// ptrIf returns &v when valid, else nil: a nullable column as an optional value.
func ptrIf[T any](v T, valid bool) *T {
	if !valid {
		return nil
	}
	return &v
}
