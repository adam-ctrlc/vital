package device

import (
	"time"

	"github.com/adam-ctrlc/vital/api/internal/wire"
)

// ConnectedWindow is how recently a hardware reading must have arrived for the
// link to count as live.
//
// It lives here rather than in readings because readings imports this package
// (the ingest response carries the relay command), so the dependency can only
// run that way.
const ConnectedWindow = 30 * time.Second

// IsWithinConnectedWindow reports whether a hardware reading recorded at
// recordedAt is recent enough, as of now, to count as connected. The boundary
// counts as connected, and so does a reading stamped slightly in the future.
func IsWithinConnectedWindow(recordedAt, now time.Time) bool {
	return now.Sub(recordedAt) <= ConnectedWindow
}

// Telemetry is the singleton device_telemetry row: what the firmware last
// reported about itself. The identity fields are nil until it has reported in.
type Telemetry struct {
	DeviceID       *string
	Firmware       *string
	SSID           *string
	IPAddress      *string
	SignalDBm      *int32
	UptimeSeconds  *int64
	RelayLockedOut bool
}

// HardwareSample is the newest hardware reading, reduced to what the status needs.
// Both fields come from one row so they describe the same instant: asking twice
// could straddle an incoming sample and pair a relay position with a time it never
// went with.
type HardwareSample struct {
	RecordedAt time.Time
	// RelayClosed is nil when the reading did not report the contacts.
	RelayClosed *bool
}

// Status is the live link state for the admin Settings screen, the response of
// GET /device/status. Every key is always present; absent values are null.
type Status struct {
	Connected bool `json:"connected"`
	// RelayLockedOut means the relay is open and will stay open until an admin
	// resets it. It is the board's own report and does not expire with the link.
	RelayLockedOut bool `json:"relayLockedOut"`
	// RelayClosed is the relay's position as of the newest hardware reading, or null
	// when unknown. Distinct from the lockout: a relay can be open without being
	// locked out, while it waits out a reclose delay.
	RelayClosed   *bool      `json:"relayClosed"`
	DeviceID      *string    `json:"deviceId"`
	Firmware      *string    `json:"firmware"`
	IPAddress     *string    `json:"ipAddress"`
	SignalDBm     *int32     `json:"signalDbm"`
	UptimeSeconds *int64     `json:"uptimeSeconds"`
	SSID          *string    `json:"ssid"`
	LastSeenAt    *wire.Time `json:"lastSeenAt"`
	LastSeenLabel *string    `json:"lastSeenLabel"`
	// Simulated is true when the live feed is simulated rather than driven by hardware.
	Simulated bool `json:"simulated"`
}

// BuildStatus combines the stored telemetry, the newest hardware reading (nil if
// there has never been one) and the settings' source mode into the link state as
// of now.
func BuildStatus(t Telemetry, latest *HardwareSample, sourceMode string, now time.Time) Status {
	status := Status{
		RelayLockedOut: t.RelayLockedOut,
		DeviceID:       t.DeviceID,
		Firmware:       t.Firmware,
		IPAddress:      t.IPAddress,
		SignalDBm:      t.SignalDBm,
		UptimeSeconds:  t.UptimeSeconds,
		SSID:           t.SSID,
		Simulated:      sourceMode != "hardware",
	}
	if latest == nil {
		return status
	}

	status.Connected = IsWithinConnectedWindow(latest.RecordedAt, now)
	status.LastSeenAt = &wire.Time{Time: latest.RecordedAt}
	label := wire.LocalLabel(latest.RecordedAt)
	status.LastSeenLabel = &label

	// The position expires with the link. Last seen deliberately does not, because
	// "the board was last here at 06:04" stays true however old it gets, while "the
	// relay is closed" does not: the board may have tripped, been switched off, or
	// been unplugged since, and none of that reaches us.
	//
	// Held past the window, one stale row reports a confident CLOSED forever, which
	// claims the supply is reaching the load on the strength of a reading from hours
	// ago. Unknown is the honest answer and the app already renders it.
	if status.Connected {
		status.RelayClosed = latest.RelayClosed
	}

	return status
}
