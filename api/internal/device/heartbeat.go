package device

import "strings"

// Heartbeat is the telemetry the firmware self-reports on POST /device/heartbeat.
//
// Every field is optional so a heartbeat can carry only what changed: an absent or
// null field keeps its stored value rather than clearing it. The firmware sends the
// first seven every time, but the store does not rely on that.
//
// The integer widths match the Rust i32 and i64, so a value that does not fit is
// refused at decoding (422) rather than truncated.
type Heartbeat struct {
	DeviceID      *string `json:"deviceId"`
	Firmware      *string `json:"firmware"`
	SSID          *string `json:"ssid"`
	IPAddress     *string `json:"ipAddress"`
	SignalDBm     *int32  `json:"signalDbm"`
	UptimeSeconds *int64  `json:"uptimeSeconds"`
	// RelayLockedOut reports that the relay is open and out of reclose attempts, so
	// an operator can tell "off on purpose" from "the board died".
	RelayLockedOut *bool `json:"relayLockedOut"`
	// RelayCommandAck is the highest relay command id the board has applied. Present,
	// the pending command is kept and redelivered until acknowledged; absent (firmware
	// from before acknowledgements), it is handed over once and cleared. See handover.
	RelayCommandAck *int64 `json:"relayCommandAck"`
	// ResetReason is why the board last restarted, from esp_reset_reason(). Anything
	// outside resetReasons is stored as "other".
	ResetReason *string `json:"resetReason"`
}

// resetReasons are the reset reasons stored as the board sent them.
var resetReasons = map[string]bool{
	"poweron": true, "brownout": true, "panic": true, "task_wdt": true, "int_wdt": true,
	"wdt": true, "sw": true, "deepsleep": true, "ext": true, "other": true,
}

// normalizedResetReason keeps a known reason, files anything else under "other", and
// treats a blank one as absent, so a firmware typo cannot fail the heartbeat.
func normalizedResetReason(raw *string) *string {
	if raw == nil || strings.TrimSpace(*raw) == "" {
		return nil
	}
	reason := strings.ToLower(strings.TrimSpace(*raw))
	if !resetReasons[reason] {
		reason = "other"
	}
	return &reason
}

// args returns the parameters for sqlRecordHeartbeat, in placeholder order. An
// absent field is passed as SQL NULL, which the statement's coalesce turns into
// "keep the stored value".
func (h Heartbeat) args() []any {
	return []any{
		nullable(h.DeviceID),
		nullable(h.Firmware),
		nullable(h.SSID),
		nullable(h.IPAddress),
		nullable(h.SignalDBm),
		nullable(h.UptimeSeconds),
		nullable(h.RelayLockedOut),
		nullable(normalizedResetReason(h.ResetReason)),
	}
}

// nullable dereferences p for a query argument, or returns an untyped nil (SQL NULL).
// Done here rather than left to database/sql's pointer handling so the arguments do
// not depend on how a particular driver converts them.
func nullable[T any](p *T) any {
	if p == nil {
		return nil
	}
	return *p
}
