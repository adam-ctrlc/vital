package device

import (
	"context"
	"database/sql"
	"errors"
	"path/filepath"
	"sync"
	"testing"
	"time"

	_ "modernc.org/sqlite" // a real SQLite, so BEGIN IMMEDIATE and the locks are real
)

// testSchema is the part of schema.sql the store touches.
const testSchema = `
create table device_telemetry (
    id               integer primary key check (id = 1),
    device_id        text,
    firmware         text,
    ssid             text,
    ip_address       text,
    signal_dbm       integer,
    uptime_seconds   integer,
    relay_command    text check (relay_command is null or relay_command in ('open', 'close')),
    relay_command_id integer not null default 0,
    relay_command_at text,
    relay_locked_out integer not null default 0,
    reset_reason     text,
    reported_at      text not null default (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);
insert into device_telemetry (id) values (1);
create table readings (
    id           integer primary key autoincrement,
    relay_closed integer,
    source       text not null default 'simulator',
    recorded_at  text not null default (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);`

// openTestDB opens a file database (so every pooled connection sees the same data)
// with a busy timeout, so a second BEGIN IMMEDIATE waits for the first to commit as
// it does on Turso, rather than failing at once.
func openTestDB(t *testing.T) *sql.DB {
	t.Helper()
	path := filepath.Join(t.TempDir(), "device.db")
	db, err := sql.Open("sqlite", "file:"+path+"?_pragma=busy_timeout(10000)")
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { db.Close() })
	if _, err := db.Exec(testSchema); err != nil {
		t.Fatal(err)
	}
	return db
}

// testNow is the clock the relay tests run on. Commands are requested at it and
// handed over at it unless a test moves on, so they are inside CommandLifetime.
var testNow = time.Date(2026, 10, 9, 6, 0, 0, 0, time.UTC)

// takeOnce is the reading ingest's handover for firmware that does not acknowledge.
func takeOnce(ctx context.Context, s *Store) (Command, error) {
	p, err := s.RelayHandover(ctx, nil, testNow)
	return p.Command, err
}

// heartbeatOnce is the heartbeat's handover for firmware that does not acknowledge.
func heartbeatOnce(ctx context.Context, s *Store, hb Heartbeat) (Command, error) {
	p, err := s.RecordHeartbeat(ctx, hb, testNow)
	return p.Command, err
}

func mustExec(t *testing.T, db *sql.DB, query string, args ...any) {
	t.Helper()
	if _, err := db.Exec(query, args...); err != nil {
		t.Fatalf("%s: %v", query, err)
	}
}

func TestRelayCommandIsHandedOverExactlyOnce(t *testing.T) {
	ctx := context.Background()

	tests := []struct {
		name  string
		first func(*Store) (Command, error)
		then  func(*Store) (Command, error)
	}{
		{
			name:  "heartbeat, then heartbeat",
			first: func(s *Store) (Command, error) { return heartbeatOnce(ctx, s, Heartbeat{}) },
			then:  func(s *Store) (Command, error) { return heartbeatOnce(ctx, s, Heartbeat{}) },
		},
		{
			name:  "reading ingest, then heartbeat",
			first: func(s *Store) (Command, error) { return takeOnce(ctx, s) },
			then:  func(s *Store) (Command, error) { return heartbeatOnce(ctx, s, Heartbeat{}) },
		},
		{
			name:  "heartbeat, then reading ingest",
			first: func(s *Store) (Command, error) { return heartbeatOnce(ctx, s, Heartbeat{}) },
			then:  func(s *Store) (Command, error) { return takeOnce(ctx, s) },
		},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			store := NewStore(openTestDB(t))
			if err := store.RequestRelayCommand(ctx, CommandOpen, testNow); err != nil {
				t.Fatal(err)
			}

			got, err := tt.first(store)
			if err != nil || got != CommandOpen {
				t.Fatalf("first request got %q, %v; want open", got, err)
			}
			got, err = tt.then(store)
			if err != nil || got != CommandNone {
				t.Fatalf("second request got %q, %v; want nothing", got, err)
			}
		})
	}
}

func TestNothingPendingHandsOverNothing(t *testing.T) {
	ctx := context.Background()
	store := NewStore(openTestDB(t))

	if got, err := takeOnce(ctx, store); err != nil || got != CommandNone {
		t.Errorf("RelayHandover = %q, %v", got, err)
	}
	if got, err := heartbeatOnce(ctx, store, Heartbeat{}); err != nil || got != CommandNone {
		t.Errorf("RecordHeartbeat = %q, %v", got, err)
	}
}

func TestMissingTelemetryRowIsNotAnError(t *testing.T) {
	ctx := context.Background()
	db := openTestDB(t)
	mustExec(t, db, "delete from device_telemetry")
	store := NewStore(db)

	if got, err := takeOnce(ctx, store); err != nil || got != CommandNone {
		t.Errorf("RelayHandover = %q, %v", got, err)
	}
	if got, err := store.Telemetry(ctx); err != nil || got != (Telemetry{}) {
		t.Errorf("Telemetry = %+v, %v", got, err)
	}
}

func TestALaterCommandReplacesAPendingOne(t *testing.T) {
	ctx := context.Background()
	store := NewStore(openTestDB(t))

	for _, cmd := range []Command{CommandOpen, CommandClose} {
		if err := store.RequestRelayCommand(ctx, cmd, testNow); err != nil {
			t.Fatal(err)
		}
	}
	if got, err := takeOnce(ctx, store); err != nil || got != CommandClose {
		t.Errorf("got %q, %v; want close", got, err)
	}
}

// TestConcurrentRequestsShareOneCommand is the race the transaction exists for:
// many requests arriving together, one pending command, exactly one taker, and no
// request turned into an error by losing the race.
func TestConcurrentRequestsShareOneCommand(t *testing.T) {
	ctx := context.Background()
	store := NewStore(openTestDB(t))
	if err := store.RequestRelayCommand(ctx, CommandClose, testNow); err != nil {
		t.Fatal(err)
	}

	const requests = 16
	var (
		wg      sync.WaitGroup
		mu      sync.Mutex
		handed  []Command
		failure []error
	)
	for i := range requests {
		wg.Go(func() {
			var (
				got Command
				err error
			)
			if i%2 == 0 {
				got, err = heartbeatOnce(ctx, store, Heartbeat{UptimeSeconds: ptr(int64(i))})
			} else {
				got, err = takeOnce(ctx, store)
			}
			mu.Lock()
			defer mu.Unlock()
			if err != nil {
				failure = append(failure, err)
			}
			if got != CommandNone {
				handed = append(handed, got)
			}
		})
	}
	wg.Wait()

	if len(failure) > 0 {
		t.Fatalf("%d requests failed, first: %v", len(failure), failure[0])
	}
	if len(handed) != 1 || handed[0] != CommandClose {
		t.Fatalf("command handed over %d times (%v), want exactly once", len(handed), handed)
	}
}

// TestAFailedHandoverKeepsTheCommand: for firmware that does not acknowledge, a
// command is cleared as it is read, so a request that fails after reading it must
// not take it away with it.
func TestAFailedHandoverKeepsTheCommand(t *testing.T) {
	ctx := context.Background()
	db := openTestDB(t)
	store := NewStore(db)
	if err := store.RequestRelayCommand(ctx, CommandOpen, testNow); err != nil {
		t.Fatal(err)
	}

	mustExec(t, db, `create trigger refuse before update on device_telemetry
		begin select raise(abort, 'refused'); end`)
	if _, err := store.RecordHeartbeat(ctx, Heartbeat{}, testNow); err == nil {
		t.Fatal("RecordHeartbeat succeeded through a refusing trigger")
	}
	mustExec(t, db, "drop trigger refuse")

	// The failed transaction was rolled back and released its lock: the command is
	// still there and the next request gets it.
	if got, err := takeOnce(ctx, store); err != nil || got != CommandOpen {
		t.Fatalf("after a failed handover got %q, %v; want open", got, err)
	}
}

func TestRecordHeartbeatCoalescesAbsentFields(t *testing.T) {
	ctx := context.Background()
	store := NewStore(openTestDB(t))

	full := Heartbeat{
		DeviceID: ptr("vital-esp32-01"), Firmware: ptr("1.0.0"), SSID: ptr("home"),
		IPAddress: ptr("192.168.1.20"), SignalDBm: ptr[int32](-61),
		UptimeSeconds: ptr[int64](100), RelayLockedOut: ptr(true),
	}
	if _, err := store.RecordHeartbeat(ctx, full, testNow); err != nil {
		t.Fatal(err)
	}
	// Only uptime changes; null reads as absent too.
	if _, err := store.RecordHeartbeat(ctx, Heartbeat{UptimeSeconds: ptr[int64](130)}, testNow); err != nil {
		t.Fatal(err)
	}

	got, err := store.Telemetry(ctx)
	if err != nil {
		t.Fatal(err)
	}
	want := Telemetry{
		DeviceID: full.DeviceID, Firmware: full.Firmware, SSID: full.SSID, IPAddress: full.IPAddress,
		SignalDBm: full.SignalDBm, UptimeSeconds: ptr[int64](130), RelayLockedOut: true,
	}
	if !equalTelemetry(got, want) {
		t.Errorf("got %+v, want %+v", got, want)
	}

	// An explicit false clears the lockout, which coalesce must not mistake for absent.
	if _, err := store.RecordHeartbeat(ctx, Heartbeat{RelayLockedOut: ptr(false)}, testNow); err != nil {
		t.Fatal(err)
	}
	if got, err := store.Telemetry(ctx); err != nil || got.RelayLockedOut {
		t.Errorf("RelayLockedOut = %v, %v; want false", got.RelayLockedOut, err)
	}
}

func TestDatabaseRefusesAnUnknownCommand(t *testing.T) {
	// The schema's check is the second line of defence behind ParseCommand.
	store := NewStore(openTestDB(t))
	if err := store.RequestRelayCommand(context.Background(), Command("toggle"), testNow); err == nil {
		t.Error("an unknown command was stored")
	}
}

func TestLatestHardware(t *testing.T) {
	ctx := context.Background()

	tests := []struct {
		name      string
		rows      [][3]any // relay_closed, source, recorded_at
		want      *HardwareSample
		wantError error
	}{
		{name: "no readings at all"},
		{
			name: "simulated readings do not count",
			rows: [][3]any{{nil, "simulator", "2026-10-09T06:04:00.000Z"}},
		},
		{
			name: "the newest hardware row, position and time together",
			rows: [][3]any{
				{1, "hardware", "2026-10-09T06:03:00.000Z"},
				{0, "hardware", "2026-10-09T06:04:25.120Z"},
				{1, "simulator", "2026-10-09T06:05:00.000Z"},
			},
			want: &HardwareSample{
				RecordedAt:  time.Date(2026, 10, 9, 6, 4, 25, 120_000_000, time.UTC),
				RelayClosed: ptr(false),
			},
		},
		{
			name: "a reading that did not report the contacts",
			rows: [][3]any{{nil, "hardware", "2026-10-09T06:04:00.000Z"}},
			want: &HardwareSample{RecordedAt: time.Date(2026, 10, 9, 6, 4, 0, 0, time.UTC)},
		},
		{
			name:      "an unreadable timestamp is an error, never now",
			rows:      [][3]any{{1, "hardware", "yesterday-ish"}},
			wantError: ErrUnreadableTimestamp,
		},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			db := openTestDB(t)
			for _, r := range tt.rows {
				mustExec(t, db, "insert into readings (relay_closed, source, recorded_at) values (?1, ?2, ?3)", r[0], r[1], r[2])
			}

			got, err := NewStore(db).LatestHardware(ctx)
			if tt.wantError != nil {
				if !errors.Is(err, tt.wantError) {
					t.Fatalf("err = %v, want %v", err, tt.wantError)
				}
				return
			}
			if err != nil {
				t.Fatal(err)
			}
			if (got == nil) != (tt.want == nil) {
				t.Fatalf("got %+v, want %+v", got, tt.want)
			}
			if got != nil && (!got.RecordedAt.Equal(tt.want.RecordedAt) || !equalPtr(got.RelayClosed, tt.want.RelayClosed)) {
				t.Errorf("got %+v (closed %v), want %+v (closed %v)",
					got, deref(got.RelayClosed), tt.want, deref(tt.want.RelayClosed))
			}
		})
	}
}

func TestStoreStatus(t *testing.T) {
	ctx := context.Background()
	db := openTestDB(t)
	store := NewStore(db)

	recorded := time.Date(2026, 10, 9, 6, 4, 25, 0, time.UTC)
	mustExec(t, db, "insert into readings (relay_closed, source, recorded_at) values (1, 'hardware', ?1)",
		recorded.Format("2006-01-02T15:04:05.000Z"))
	if _, err := store.RecordHeartbeat(ctx, Heartbeat{DeviceID: ptr("vital-esp32-01"), RelayLockedOut: ptr(true)}, testNow); err != nil {
		t.Fatal(err)
	}

	live, err := store.Status(ctx, "hardware", recorded.Add(10*time.Second))
	if err != nil {
		t.Fatal(err)
	}
	if !live.Connected || !equalPtr(live.RelayClosed, ptr(true)) || !live.RelayLockedOut ||
		!equalPtr(live.DeviceID, ptr("vital-esp32-01")) || live.Simulated {
		t.Errorf("live status = %+v", live)
	}

	later, err := store.Status(ctx, "hardware", recorded.Add(time.Hour))
	if err != nil {
		t.Fatal(err)
	}
	if later.Connected || later.RelayClosed != nil || later.LastSeenAt == nil || !later.RelayLockedOut {
		t.Errorf("stale status = %+v", later)
	}
}

func equalTelemetry(a, b Telemetry) bool {
	return equalPtr(a.DeviceID, b.DeviceID) && equalPtr(a.Firmware, b.Firmware) &&
		equalPtr(a.SSID, b.SSID) && equalPtr(a.IPAddress, b.IPAddress) &&
		equalPtr(a.SignalDBm, b.SignalDBm) && equalPtr(a.UptimeSeconds, b.UptimeSeconds) &&
		a.RelayLockedOut == b.RelayLockedOut && equalPtr(a.ResetReason, b.ResetReason)
}

// handover runs the acknowledging firmware's handover at testNow plus after.
func handover(t *testing.T, s *Store, ack int64, after time.Duration) Pending {
	t.Helper()
	p, err := s.RelayHandover(context.Background(), &ack, testNow.Add(after))
	if err != nil {
		t.Fatal(err)
	}
	return p
}

func TestAcknowledgingFirmwareGetsTheCommandUntilItAcknowledges(t *testing.T) {
	ctx := context.Background()
	store := NewStore(openTestDB(t))
	if err := store.RequestRelayCommand(ctx, CommandOpen, testNow); err != nil {
		t.Fatal(err)
	}
	want := Pending{Command: CommandOpen, ID: 1}

	// The response carrying it was lost: the next request gets it again, same id,
	// whichever route it comes by.
	if got := handover(t, store, 0, time.Second); got != want {
		t.Fatalf("first handover = %+v, want %+v", got, want)
	}
	if got := handover(t, store, 0, 5*time.Second); got != want {
		t.Fatalf("redelivery = %+v, want %+v", got, want)
	}
	hb, err := store.RecordHeartbeat(ctx, Heartbeat{RelayCommandAck: ptr[int64](0)}, testNow.Add(6*time.Second))
	if err != nil || hb != want {
		t.Fatalf("heartbeat handover = %+v, %v; want %+v", hb, err, want)
	}

	// Acknowledged: cleared, for every kind of request after it.
	if got := handover(t, store, 1, 10*time.Second); got != (Pending{}) {
		t.Fatalf("after the ack = %+v, want nothing", got)
	}
	if got, err := takeOnce(ctx, store); err != nil || got != CommandNone {
		t.Fatalf("old firmware after the ack = %q, %v; want nothing", got, err)
	}
}

func TestEachRequestTakesTheNextID(t *testing.T) {
	ctx := context.Background()
	store := NewStore(openTestDB(t))
	for _, cmd := range []Command{CommandOpen, CommandClose} {
		if err := store.RequestRelayCommand(ctx, cmd, testNow); err != nil {
			t.Fatal(err)
		}
	}

	// The board applied the first before the second replaced it: acknowledging the
	// first leaves the second pending.
	if got := handover(t, store, 1, time.Second); got != (Pending{Command: CommandClose, ID: 2}) {
		t.Fatalf("after acknowledging 1 = %+v, want close 2", got)
	}
	if got := handover(t, store, 2, time.Second); got != (Pending{}) {
		t.Fatalf("after acknowledging 2 = %+v, want nothing", got)
	}

	// The id keeps counting after a clear, so an old acknowledgement never matches
	// a new command.
	if err := store.RequestRelayCommand(ctx, CommandOpen, testNow); err != nil {
		t.Fatal(err)
	}
	if got := handover(t, store, 2, time.Second); got != (Pending{Command: CommandOpen, ID: 3}) {
		t.Fatalf("new command = %+v, want open 3", got)
	}
}

func TestAStaleCommandIsDropped(t *testing.T) {
	ctx := context.Background()
	for _, ack := range []*int64{nil, ptr[int64](0)} {
		db := openTestDB(t)
		store := NewStore(db)
		if err := store.RequestRelayCommand(ctx, CommandClose, testNow); err != nil {
			t.Fatal(err)
		}

		late := testNow.Add(CommandLifetime + time.Second)
		if got, err := store.RelayHandover(ctx, ack, late); err != nil || got != (Pending{}) {
			t.Fatalf("ack %v: stale handover = %+v, %v; want nothing", ack, got, err)
		}
		// Cleared, not just withheld: going back in time does not bring it back.
		if got, err := store.RelayHandover(ctx, ack, testNow); err != nil || got != (Pending{}) {
			t.Fatalf("ack %v: after expiry = %+v, %v; want nothing", ack, got, err)
		}
	}
}

func TestACommandWithoutARequestTime(t *testing.T) {
	ctx := context.Background()

	// Queued by the API from before 0024, which does not stamp it: delivered.
	db := openTestDB(t)
	mustExec(t, db, "update device_telemetry set relay_command = 'open' where id = 1")
	if got, err := takeOnce(ctx, NewStore(db)); err != nil || got != CommandOpen {
		t.Errorf("unstamped command = %q, %v; want open", got, err)
	}

	// Stamped with something unreadable: of unknown age, so dropped.
	db = openTestDB(t)
	mustExec(t, db, "update device_telemetry set relay_command = 'open', relay_command_id = 4, relay_command_at = 'soon' where id = 1")
	if got, err := takeOnce(ctx, NewStore(db)); err != nil || got != CommandNone {
		t.Errorf("unreadable stamp = %q, %v; want nothing", got, err)
	}
}

func TestDecideHandover(t *testing.T) {
	stamped := sql.NullString{String: "2026-10-09T05:59:30.000Z", Valid: true}
	open := Pending{Command: CommandOpen, ID: 5}

	tests := []struct {
		name        string
		pending     Pending
		requestedAt sql.NullString
		ack         *int64
		deliver     Pending
		clear       bool
	}{
		{name: "nothing pending", ack: ptr[int64](9)},
		{name: "old firmware takes it once", pending: open, requestedAt: stamped, deliver: open, clear: true},
		{name: "not yet acknowledged", pending: open, requestedAt: stamped, ack: ptr[int64](4), deliver: open},
		{name: "acknowledged", pending: open, requestedAt: stamped, ack: ptr[int64](5), clear: true},
		{name: "acknowledged past it", pending: open, requestedAt: stamped, ack: ptr[int64](8), clear: true},
		{
			name: "expired", pending: open, ack: ptr[int64](4), clear: true,
			requestedAt: sql.NullString{String: "2026-10-09T05:58:59.000Z", Valid: true},
		},
		{
			name: "exactly at the lifetime is still live", pending: open, ack: ptr[int64](4), deliver: open,
			requestedAt: sql.NullString{String: "2026-10-09T05:59:00.000Z", Valid: true},
		},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			deliver, clear := decideHandover(tt.pending, tt.requestedAt, tt.ack, testNow)
			if deliver != tt.deliver || clear != tt.clear {
				t.Errorf("got %+v, clear %v; want %+v, clear %v", deliver, clear, tt.deliver, tt.clear)
			}
		})
	}
}

func TestResetReasonIsStoredNormalized(t *testing.T) {
	ctx := context.Background()
	store := NewStore(openTestDB(t))

	steps := []struct {
		sent *string
		want *string
	}{
		{sent: nil, want: nil},
		{sent: ptr(" BROWNOUT "), want: ptr("brownout")},
		{sent: ptr(""), want: ptr("brownout")}, // blank is absent, so the last one stays
		{sent: ptr("cosmic_ray"), want: ptr("other")},
		{sent: ptr("task_wdt"), want: ptr("task_wdt")},
	}
	for _, step := range steps {
		if _, err := store.RecordHeartbeat(ctx, Heartbeat{ResetReason: step.sent}, testNow); err != nil {
			t.Fatal(err)
		}
		got, err := store.Telemetry(ctx)
		if err != nil {
			t.Fatal(err)
		}
		if !equalPtr(got.ResetReason, step.want) {
			t.Errorf("sent %v: stored %v, want %v", deref(step.sent), deref(got.ResetReason), deref(step.want))
		}
	}
}
