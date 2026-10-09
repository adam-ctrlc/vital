package readings

import (
	"time"

	"github.com/adam-ctrlc/vital/api/internal/device"
	"github.com/adam-ctrlc/vital/api/internal/wire"
)

// Reading is a stored measurement, as the log and the ingest acknowledgement return it.
//
// Every measurement is nullable and serialised as null when absent, never omitted.
type Reading struct {
	ID              int64       `json:"id"`
	VoltageV        *wire.Float `json:"voltageV"`
	CurrentA        *wire.Float `json:"currentA"`
	TemperatureC    *wire.Float `json:"temperatureC"`
	ApparentPowerVA *wire.Float `json:"apparentPowerVa"`
	Status          string      `json:"status"`
	Source          string      `json:"source"`
	PowerW          *wire.Float `json:"powerW"`
	PowerFactor     *wire.Float `json:"powerFactor"`
	FrequencyHz     *wire.Float `json:"frequencyHz"`
	EnergyKwh       *wire.Float `json:"energyKwh"`
	// RelayClosed is whether the relay was passing load when this row was measured.
	// Stored as the integer 0 or 1; null for a simulated reading, which has no contacts.
	RelayClosed *bool     `json:"relayClosed"`
	RecordedAt  wire.Time `json:"recordedAt"`
}

// LiveReading is the dashboard heartbeat payload: live values plus the thresholds
// they are judged against. Build it with newLiveReading.
type LiveReading struct {
	VoltageV     *wire.Float `json:"voltageV"`
	CurrentA     *wire.Float `json:"currentA"`
	TemperatureC *wire.Float `json:"temperatureC"`
	// TemperatureF is derived from TemperatureC on the way out and never stored, so
	// the two cannot drift.
	TemperatureF    *wire.Float `json:"temperatureF"`
	ApparentPowerVA *wire.Float `json:"apparentPowerVa"`
	Status          Status      `json:"status"`
	LoadThresholdVA wire.Float  `json:"loadThresholdVa"`
	// TripThresholdVA is where the board opens the relay, so the dashboard can show
	// the room left before the load is cut, not just before the alarm sounds.
	TripThresholdVA wire.Float  `json:"tripThresholdVa"`
	TempThresholdC  wire.Float  `json:"tempThresholdC"`
	TempThresholdF  wire.Float  `json:"tempThresholdF"`
	LoadPercent     *wire.Float `json:"loadPercent"`
	OverTemperature bool        `json:"overTemperature"`
	PowerW          *wire.Float `json:"powerW"`
	PowerFactor     *wire.Float `json:"powerFactor"`
	FrequencyHz     *wire.Float `json:"frequencyHz"`
	EnergyKwh       *wire.Float `json:"energyKwh"`
	// ReactivePowerVar is Q = sqrt(S^2 - P^2), present only when real power is.
	ReactivePowerVar *wire.Float `json:"reactivePowerVar"`
	// HeadroomVA is the VA left before the load threshold, negative once over.
	HeadroomVA *wire.Float `json:"headroomVa"`
	RecordedAt wire.Time   `json:"recordedAt"`
	// Simulated is true when the feed is derived from the clock rather than a board.
	Simulated bool `json:"simulated"`
	// Connected is true when a hardware reading arrived inside the connected window.
	Connected bool `json:"connected"`
	// RelayClosed is the relay position as of the newest reading.
	RelayClosed *bool `json:"relayClosed"`
	// DeviceIP is the board's address on its own network, sent to every role so the
	// app can read the board directly on a shared network. Only set while connected.
	DeviceIP *string `json:"deviceIp"`
}

// TrendPoint is one UTC day of the trend. The aggregates are null for a day with no
// load (or no temperature) readings at all.
type TrendPoint struct {
	Day             wire.Time   `json:"day"`
	AvgPowerVA      *wire.Float `json:"avgPowerVa"`
	MaxPowerVA      *wire.Float `json:"maxPowerVa"`
	AvgTemperatureC *wire.Float `json:"avgTemperatureC"`
	Samples         int64       `json:"samples"`
}

// IngestAck is what the board gets back when it posts a reading: the row it just
// wrote, flattened so older firmware sees the shape it always has, plus any relay
// command an operator queued.
//
// The command rides here because the board already makes this request every few
// seconds; a separate poll would cost radio time the board cannot spare.
type IngestAck struct {
	Reading
	// RelayCommand is "open", "close", or null. Handed over exactly once.
	RelayCommand device.Command `json:"relayCommand"`
}

// wired converts an optional measurement to its JSON form.
func wired(v *float64) *wire.Float {
	if v == nil {
		return nil
	}
	return wire.Ptr(*v)
}

// unwire is the inverse of wired.
func unwire(v *wire.Float) *float64 {
	if v == nil {
		return nil
	}
	f := float64(*v)
	return &f
}

// stamp wraps an instant for JSON.
func stamp(t time.Time) wire.Time {
	return wire.Time{Time: t.UTC()}
}
