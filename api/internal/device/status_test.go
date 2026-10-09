package device

import (
	"encoding/json"
	"testing"
	"time"
)

func TestIsWithinConnectedWindow(t *testing.T) {
	now := time.Date(2026, 10, 9, 6, 4, 0, 0, time.UTC)
	tests := []struct {
		name string
		age  time.Duration
		want bool
	}{
		{"just now", 0, true},
		{"a few seconds old", 5 * time.Second, true},
		{"exactly at the window counts", 30 * time.Second, true},
		{"a millisecond past it does not", 30*time.Second + time.Millisecond, false},
		{"hours old", 3 * time.Hour, false},
		{"stamped slightly in the future", -2 * time.Second, true},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			if got := IsWithinConnectedWindow(now.Add(-tt.age), now); got != tt.want {
				t.Errorf("got %v, want %v", got, tt.want)
			}
		})
	}
}

func TestBuildStatus(t *testing.T) {
	now := time.Date(2026, 10, 9, 6, 4, 30, 0, time.UTC)
	reported := Telemetry{
		DeviceID:       ptr("vital-esp32-01"),
		Firmware:       ptr("1.0.0"),
		SSID:           ptr("home"),
		IPAddress:      ptr("192.168.1.20"),
		SignalDBm:      ptr[int32](-61),
		UptimeSeconds:  ptr[int64](3600),
		RelayLockedOut: true,
	}
	fresh := &HardwareSample{RecordedAt: now.Add(-5 * time.Second), RelayClosed: ptr(true)}
	stale := &HardwareSample{RecordedAt: now.Add(-2 * time.Hour), RelayClosed: ptr(true)}

	tests := []struct {
		name          string
		telemetry     Telemetry
		latest        *HardwareSample
		sourceMode    string
		wantConnected bool
		wantClosed    *bool
		wantLastSeen  bool
		wantSimulated bool
	}{
		{
			name:          "never reported: everything unknown",
			sourceMode:    "hardware",
			wantConnected: false,
		},
		{
			name:          "a fresh reading: connected with a known position",
			telemetry:     reported,
			latest:        fresh,
			sourceMode:    "hardware",
			wantConnected: true,
			wantClosed:    ptr(true),
			wantLastSeen:  true,
		},
		{
			name:          "a fresh reading that did not report the contacts",
			latest:        &HardwareSample{RecordedAt: fresh.RecordedAt},
			sourceMode:    "hardware",
			wantConnected: true,
			wantLastSeen:  true,
		},
		{
			name:          "a stale reading: position expires, last seen does not",
			telemetry:     reported,
			latest:        stale,
			sourceMode:    "hardware",
			wantConnected: false,
			wantClosed:    nil,
			wantLastSeen:  true,
		},
		{
			name:          "simulation mode is flagged",
			latest:        fresh,
			sourceMode:    "simulator",
			wantConnected: true,
			wantClosed:    ptr(true),
			wantLastSeen:  true,
			wantSimulated: true,
		},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			got := BuildStatus(tt.telemetry, tt.latest, tt.sourceMode, now)

			if got.Connected != tt.wantConnected {
				t.Errorf("Connected = %v, want %v", got.Connected, tt.wantConnected)
			}
			if !equalPtr(got.RelayClosed, tt.wantClosed) {
				t.Errorf("RelayClosed = %v, want %v", deref(got.RelayClosed), deref(tt.wantClosed))
			}
			if (got.LastSeenAt != nil) != tt.wantLastSeen || (got.LastSeenLabel != nil) != tt.wantLastSeen {
				t.Errorf("last seen = %v / %v, want present=%v", got.LastSeenAt, got.LastSeenLabel, tt.wantLastSeen)
			}
			if got.Simulated != tt.wantSimulated {
				t.Errorf("Simulated = %v, want %v", got.Simulated, tt.wantSimulated)
			}
			// The lockout is the board's own report and is carried whatever the link.
			if got.RelayLockedOut != tt.telemetry.RelayLockedOut {
				t.Errorf("RelayLockedOut = %v, want %v", got.RelayLockedOut, tt.telemetry.RelayLockedOut)
			}
			if got.DeviceID != tt.telemetry.DeviceID || got.UptimeSeconds != tt.telemetry.UptimeSeconds {
				t.Errorf("identity fields not carried over from telemetry")
			}
		})
	}
}

func TestStatusJSON(t *testing.T) {
	now := time.Date(2026, 10, 9, 6, 4, 30, 0, time.UTC)

	t.Run("nothing reported: every key present, null", func(t *testing.T) {
		got, err := json.Marshal(BuildStatus(Telemetry{}, nil, "simulator", now))
		if err != nil {
			t.Fatal(err)
		}
		want := `{"connected":false,"relayLockedOut":false,"relayClosed":null,"deviceId":null,` +
			`"firmware":null,"ipAddress":null,"signalDbm":null,"uptimeSeconds":null,"ssid":null,` +
			`"lastSeenAt":null,"lastSeenLabel":null,"simulated":true}`
		if string(got) != want {
			t.Errorf("got  %s\nwant %s", got, want)
		}
	})

	t.Run("live board: chrono's millisecond timestamp and the local label", func(t *testing.T) {
		latest := &HardwareSample{
			RecordedAt:  time.Date(2026, 10, 9, 6, 4, 25, 120_000_000, time.UTC),
			RelayClosed: ptr(false),
		}
		telemetry := Telemetry{
			DeviceID: ptr("vital-esp32-01"), Firmware: ptr("1.0.0"), SSID: ptr("home"),
			IPAddress: ptr("192.168.1.20"), SignalDBm: ptr[int32](-61), UptimeSeconds: ptr[int64](3600),
		}
		got, err := json.Marshal(BuildStatus(telemetry, latest, "hardware", now))
		if err != nil {
			t.Fatal(err)
		}
		want := `{"connected":true,"relayLockedOut":false,"relayClosed":false,"deviceId":"vital-esp32-01",` +
			`"firmware":"1.0.0","ipAddress":"192.168.1.20","signalDbm":-61,"uptimeSeconds":3600,"ssid":"home",` +
			`"lastSeenAt":"2026-10-09T06:04:25.120Z","lastSeenLabel":"October 9, 2026 2:04 PM","simulated":false}`
		if string(got) != want {
			t.Errorf("got  %s\nwant %s", got, want)
		}
	})
}

func equalPtr[T comparable](a, b *T) bool {
	if a == nil || b == nil {
		return a == b
	}
	return *a == *b
}

func deref[T any](p *T) any {
	if p == nil {
		return nil
	}
	return *p
}
