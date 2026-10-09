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

// RecordHeartbeat stores a heartbeat into the singleton telemetry row and takes
// the pending relay command, if any, in the same transaction. The command it
// returns is cleared from the row: the caller must deliver it on this response,
// because nothing will ever offer it again.
//
// Load the thresholds for the ack before calling this, not after. Once this
// commits the command is gone, so a failure afterwards would lose it.
func (s *Store) RecordHeartbeat(ctx context.Context, hb Heartbeat) (Command, error) {
	cmd, err := s.handover(ctx, sqlRecordHeartbeat, hb.args()...)
	if err != nil {
		return CommandNone, fmt.Errorf("record heartbeat: %w", err)
	}
	return cmd, nil
}

// TakeRelayCommand hands over any pending relay command and clears it, exactly once.
//
// The same discipline RecordHeartbeat uses, in a form the reading ingest can call.
// The two serialise against each other, so whichever arrives second reads the row
// the first already cleared and gets nothing. Without that they could both take
// the same command away and the board would act on it twice.
//
// This exists so the command can ride back on the reading the board already posts
// every few seconds, rather than needing a heartbeat of its own. Radio time is the
// scarcest thing on that board.
func (s *Store) TakeRelayCommand(ctx context.Context) (Command, error) {
	cmd, err := s.handover(ctx, sqlClearRelayCommand)
	if err != nil {
		return CommandNone, fmt.Errorf("take relay command: %w", err)
	}
	return cmd, nil
}

// handover reads the pending command and runs clear (an update that sets
// relay_command to null) inside one BEGIN IMMEDIATE transaction, returning what was
// pending.
//
// The read and the clear sharing one transaction is what makes the handover
// exactly once: no window exists in which a second request could see a command the
// first has already been given. The Sheets version could not do this. A spreadsheet
// has no read-and-write statement, so it read the row and then wrote it back, and
// two heartbeats arriving together could both take the same command away with them.
//
// Postgres did it in a single statement, reading the command out of a `for update`
// snapshot because `returning` reports the row as it is after the update. SQLite has
// no `for update` and its `returning` is post-update too, so there is no single
// statement that both clears the command and reports it. Three candidates were tried
// against SQLite 3.50 with a command waiting, and all three returned null while
// clearing the row: `returning relay_command`, `returning (select relay_command from
// device_telemetry where id = 1)`, and the same read hoisted into a `materialized`
// CTE. The subquery forms are accepted rather than rejected, which is the trap: they
// compile, they clear the command, and the board is never told what it was.
//
// Two statements in a transaction is therefore the shape, and BEGIN IMMEDIATE is the
// part that replaces `for update`: it takes the write lock up front rather than on the
// first write, so a second request cannot begin until this one commits, and it then
// reads the row this one already cleared. It gets null, so the command reaches the
// board exactly once. A deferred transaction would let both read the command before
// either wrote, and the loser would fail its write rather than read a stale value,
// which is still safe but turns a routine heartbeat into an error.
//
// That is why this does not use database/sql's BeginTx, which can only send a
// deferred BEGIN. The statements go one by one over a single *sql.Conn instead;
// over libSQL's HTTP protocol that connection carries one server-side stream, so
// they all run inside the one transaction. The transaction is the first thing on
// that connection, which matters on Turso: opening one on a connection that had just
// run another statement failed in production under the Rust API.
func (s *Store) handover(ctx context.Context, clear string, args ...any) (cmd Command, err error) {
	conn, err := s.db.Conn(ctx)
	if err != nil {
		return CommandNone, fmt.Errorf("open connection: %w", err)
	}
	defer conn.Close()

	if _, err := conn.ExecContext(ctx, sqlBeginImmediate); err != nil {
		return CommandNone, fmt.Errorf("begin immediate: %w", err)
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

	var pending sql.NullString
	if err := conn.QueryRowContext(ctx, sqlSelectRelayCommand).Scan(&pending); err != nil && !errors.Is(err, sql.ErrNoRows) {
		return CommandNone, fmt.Errorf("read pending relay command: %w", err)
	}

	if _, err := conn.ExecContext(ctx, clear, args...); err != nil {
		return CommandNone, fmt.Errorf("clear pending relay command: %w", err)
	}

	if _, err := conn.ExecContext(ctx, sqlCommit); err != nil {
		return CommandNone, fmt.Errorf("commit: %w", err)
	}

	return Command(pending.String), nil
}

// RequestRelayCommand queues an operator's relay command for whichever request
// the board makes next.
//
// It overwrites anything still pending rather than queueing behind it. Someone who
// pressed open and then close means close: replaying the first would leave the
// relay in the state they changed their mind about.
func (s *Store) RequestRelayCommand(ctx context.Context, cmd Command) error {
	if _, err := s.db.ExecContext(ctx, sqlRequestRelayCommand, string(cmd)); err != nil {
		return fmt.Errorf("queue relay command %q: %w", cmd, err)
	}
	return nil
}

// Telemetry reads what the firmware last reported. A missing row reads as nothing
// reported yet rather than an error.
func (s *Store) Telemetry(ctx context.Context) (Telemetry, error) {
	var (
		deviceID, firmware, ssid, ipAddress sql.NullString
		signalDBm                           sql.NullInt32
		uptimeSeconds                       sql.NullInt64
		t                                   Telemetry
	)
	err := s.db.QueryRowContext(ctx, sqlSelectTelemetry).Scan(
		&deviceID, &firmware, &ssid, &ipAddress, &signalDBm, &uptimeSeconds, &t.RelayLockedOut,
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
