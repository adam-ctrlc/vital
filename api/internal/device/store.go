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
// over and whether to clear it, inside one BEGIN IMMEDIATE transaction:
//
//   - nothing pending, or a command older than CommandLifetime: nothing is handed
//     over, and an expired command is cleared;
//   - ack nil (firmware from before acknowledgements): handed over and cleared, so
//     that firmware acts on it exactly once, as it always has;
//   - ack at or past the command's id: the board has applied it, so it is cleared;
//   - otherwise it is handed over and kept, and every request repeats it under the
//     same id until the board acknowledges it. A response lost on its way to the
//     board no longer loses the command with it.
//
// BEGIN IMMEDIATE takes the write lock before the read, so a second request (or an
// operator's new command) cannot begin until this one commits; reading the row this
// one already cleared, it gets nothing. A deferred transaction would let two requests
// read the same command before either wrote.
//
// That is why this does not use database/sql's BeginTx, which can only send a
// deferred BEGIN. The statements go one by one over a single *sql.Conn instead;
// over libSQL's HTTP protocol that connection carries one server-side stream, so
// they all run inside the one transaction. The transaction is the first thing on
// that connection, which matters on Turso: opening one on a connection that had just
// run another statement failed in production.
//
// The read uses two statements rather than an UPDATE ... RETURNING because SQLite's
// RETURNING reports the row after the update, so it cannot both clear the command
// and say what it was.
func (s *Store) handover(ctx context.Context, ack *int64, now time.Time, write string, args ...any) (p Pending, err error) {
	conn, err := s.db.Conn(ctx)
	if err != nil {
		return Pending{}, fmt.Errorf("open connection: %w", err)
	}
	defer conn.Close()

	if _, err := conn.ExecContext(ctx, sqlBeginImmediate); err != nil {
		return Pending{}, fmt.Errorf("begin immediate: %w", err)
	}
	defer func() {
		if err == nil {
			return
		}
		// Detached from ctx so a cancelled request still releases the write lock.
		// If even this fails, returning the connection closes its stream, which
		// abandons the transaction server side.
		if _, rbErr := conn.ExecContext(context.WithoutCancel(ctx), sqlRollback); rbErr != nil {
			err = errors.Join(err, fmt.Errorf("rollback: %w", rbErr))
		}
	}()

	if write != "" {
		if _, err := conn.ExecContext(ctx, write, args...); err != nil {
			return Pending{}, fmt.Errorf("write: %w", err)
		}
	}

	var (
		command     sql.NullString
		id          sql.NullInt64
		requestedAt sql.NullString
	)
	err = conn.QueryRowContext(ctx, sqlSelectRelayCommand).Scan(&command, &id, &requestedAt)
	if err != nil && !errors.Is(err, sql.ErrNoRows) {
		return Pending{}, fmt.Errorf("read pending relay command: %w", err)
	}
	pending := Pending{Command: Command(command.String), ID: id.Int64}

	deliver, clear := decideHandover(pending, requestedAt, ack, now)
	if clear {
		if _, err := conn.ExecContext(ctx, sqlClearRelayCommand); err != nil {
			return Pending{}, fmt.Errorf("clear pending relay command: %w", err)
		}
	}

	if _, err := conn.ExecContext(ctx, sqlCommit); err != nil {
		return Pending{}, fmt.Errorf("commit: %w", err)
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
