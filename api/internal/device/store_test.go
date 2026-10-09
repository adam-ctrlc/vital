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
    relay_locked_out integer not null default 0,
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
			first: func(s *Store) (Command, error) { return s.RecordHeartbeat(ctx, Heartbeat{}) },
			then:  func(s *Store) (Command, error) { return s.RecordHeartbeat(ctx, Heartbeat{}) },
		},
		{
			name:  "reading ingest, then heartbeat",
			first: func(s *Store) (Command, error) { return s.TakeRelayCommand(ctx) },
			then:  func(s *Store) (Command, error) { return s.RecordHeartbeat(ctx, Heartbeat{}) },
		},
		{
			name:  "heartbeat, then reading ingest",
			first: func(s *Store) (Command, error) { return s.RecordHeartbeat(ctx, Heartbeat{}) },
			then:  func(s *Store) (Command, error) { return s.TakeRelayCommand(ctx) },
		},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			store := NewStore(openTestDB(t))
			if err := store.RequestRelayCommand(ctx, CommandOpen); err != nil {
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

	if got, err := store.TakeRelayCommand(ctx); err != nil || got != CommandNone {
		t.Errorf("TakeRelayCommand = %q, %v", got, err)
	}
	if got, err := store.RecordHeartbeat(ctx, Heartbeat{}); err != nil || got != CommandNone {
		t.Errorf("RecordHeartbeat = %q, %v", got, err)
	}
}

func TestMissingTelemetryRowIsNotAnError(t *testing.T) {
	ctx := context.Background()
	db := openTestDB(t)
	mustExec(t, db, "delete from device_telemetry")
	store := NewStore(db)

	if got, err := store.TakeRelayCommand(ctx); err != nil || got != CommandNone {
		t.Errorf("TakeRelayCommand = %q, %v", got, err)
	}
	if got, err := store.Telemetry(ctx); err != nil || got != (Telemetry{}) {
		t.Errorf("Telemetry = %+v, %v", got, err)
	}
}

func TestALaterCommandReplacesAPendingOne(t *testing.T) {
	ctx := context.Background()
	store := NewStore(openTestDB(t))

	for _, cmd := range []Command{CommandOpen, CommandClose} {
		if err := store.RequestRelayCommand(ctx, cmd); err != nil {
			t.Fatal(err)
		}
	}
	if got, err := store.TakeRelayCommand(ctx); err != nil || got != CommandClose {
		t.Errorf("got %q, %v; want close", got, err)
	}
}

// TestConcurrentRequestsShareOneCommand is the race the transaction exists for:
// many requests arriving together, one pending command, exactly one taker, and no
// request turned into an error by losing the race.
func TestConcurrentRequestsShareOneCommand(t *testing.T) {
	ctx := context.Background()
	store := NewStore(openTestDB(t))
	if err := store.RequestRelayCommand(ctx, CommandClose); err != nil {
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
				got, err = store.RecordHeartbeat(ctx, Heartbeat{UptimeSeconds: ptr(int64(i))})
			} else {
				got, err = store.TakeRelayCommand(ctx)
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

// TestAFailedHandoverKeepsTheCommand: a command is cleared as it is read, so a
// request that fails after reading it must not take it away with it.
func TestAFailedHandoverKeepsTheCommand(t *testing.T) {
	ctx := context.Background()
	db := openTestDB(t)
	store := NewStore(db)
	if err := store.RequestRelayCommand(ctx, CommandOpen); err != nil {
		t.Fatal(err)
	}

	mustExec(t, db, `create trigger refuse before update on device_telemetry
		begin select raise(abort, 'refused'); end`)
	if _, err := store.RecordHeartbeat(ctx, Heartbeat{}); err == nil {
		t.Fatal("RecordHeartbeat succeeded through a refusing trigger")
	}
	mustExec(t, db, "drop trigger refuse")

	// The failed transaction was rolled back and released its lock: the command is
	// still there and the next request gets it.
	if got, err := store.TakeRelayCommand(ctx); err != nil || got != CommandOpen {
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
	if _, err := store.RecordHeartbeat(ctx, full); err != nil {
		t.Fatal(err)
	}
	// Only uptime changes; null reads as absent too.
	if _, err := store.RecordHeartbeat(ctx, Heartbeat{UptimeSeconds: ptr[int64](130)}); err != nil {
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
	if _, err := store.RecordHeartbeat(ctx, Heartbeat{RelayLockedOut: ptr(false)}); err != nil {
		t.Fatal(err)
	}
	if got, err := store.Telemetry(ctx); err != nil || got.RelayLockedOut {
		t.Errorf("RelayLockedOut = %v, %v; want false", got.RelayLockedOut, err)
	}
}

func TestDatabaseRefusesAnUnknownCommand(t *testing.T) {
	// The schema's check is the second line of defence behind ParseCommand.
	store := NewStore(openTestDB(t))
	if err := store.RequestRelayCommand(context.Background(), Command("toggle")); err == nil {
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
	if _, err := store.RecordHeartbeat(ctx, Heartbeat{DeviceID: ptr("vital-esp32-01"), RelayLockedOut: ptr(true)}); err != nil {
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
		a.RelayLockedOut == b.RelayLockedOut
}
