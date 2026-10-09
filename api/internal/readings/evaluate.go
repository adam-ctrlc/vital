package readings

import (
	"fmt"
	"math"
	"time"

	"github.com/adam-ctrlc/vital/api/internal/device"
	"github.com/adam-ctrlc/vital/api/internal/settings"
	"github.com/adam-ctrlc/vital/api/internal/wire"
)

// sourceModeHardware is the settings source_mode that serves a board's readings.
// Any other value, normally "simulation", serves the clock-derived feed.
const sourceModeHardware = "hardware"

// Evaluate derives apparent power and judges it against the load threshold.
//
// Apparent power needs both voltage and current; without either it is nil, and a
// reading with no load in it is never an overload.
func Evaluate(in Input, loadThresholdVA float64) (*float64, Status) {
	if in.VoltageV == nil || in.CurrentA == nil {
		return nil, StatusNormal
	}
	apparent := *in.VoltageV * *in.CurrentA
	if apparent >= loadThresholdVA {
		return &apparent, StatusOverload
	}
	return &apparent, StatusNormal
}

// ReactivePower is Q from the power triangle, nil unless both apparent and real
// power are present. Clamped at zero: sensor noise can make P marginally exceed S.
func ReactivePower(apparentVA, realW *float64) *float64 {
	if apparentVA == nil || realW == nil {
		return nil
	}
	s, p := *apparentVA, *realW
	q := math.Sqrt(max(math.FMA(s, s, -float64(p*p)), 0))
	return &q
}

// feed is where the live value comes from on one request.
type feed struct {
	input      Input
	recordedAt time.Time
	simulated  bool
	connected  bool
}

// resolveFeed picks the live value for a source mode.
//
// In hardware mode the newest hardware reading is served while it is inside the
// connected window (device.IsWithinConnectedWindow); a stale or absent one reads as no data at all (an empty input
// stamped now), so the dashboard shows nothing rather than the last value. Nothing
// is simulated or recorded in that mode. Any other mode serves Simulate(now).
func resolveFeed(sourceMode string, latestHardware *Reading, now time.Time) feed {
	if sourceMode == sourceModeHardware {
		if latestHardware != nil && device.IsWithinConnectedWindow(latestHardware.RecordedAt.Time, now) {
			return feed{
				input:      inputFrom(*latestHardware),
				recordedAt: latestHardware.RecordedAt.Time,
				connected:  true,
			}
		}
		return feed{recordedAt: now}
	}
	return feed{input: Simulate(now.UnixMilli()), recordedAt: now, simulated: true}
}

// newLiveReading builds the heartbeat payload from a feed.
//
// deviceIP is only passed through while connected: an address from a board that has
// gone quiet would just have the app talking to nothing.
func newLiveReading(f feed, st settings.Settings, deviceIP *string) LiveReading {
	in := f.input
	load, temp := float64(st.LoadThresholdVA), float64(st.TempThresholdC)
	apparent, status := Evaluate(in, load)

	live := LiveReading{
		VoltageV:         wired(in.VoltageV),
		CurrentA:         wired(in.CurrentA),
		TemperatureC:     wired(in.TemperatureC),
		ApparentPowerVA:  wired(apparent),
		Status:           status,
		LoadThresholdVA:  st.LoadThresholdVA,
		TripThresholdVA:  st.TripThresholdVA,
		TempThresholdC:   st.TempThresholdC,
		TempThresholdF:   wire.Float(CelsiusToFahrenheit(temp)),
		PowerW:           wired(in.PowerW),
		PowerFactor:      wired(in.PowerFactor),
		FrequencyHz:      wired(in.FrequencyHz),
		EnergyKwh:        wired(in.EnergyKwh),
		ReactivePowerVar: wired(ReactivePower(apparent, in.PowerW)),
		RecordedAt:       stamp(f.recordedAt),
		Simulated:        f.simulated,
		Connected:        f.connected,
		// Null outside the hardware path: nothing simulated holds a contact, and a
		// quiet board leaves an empty input rather than its last known position.
		RelayClosed: in.RelayClosed,
	}
	if in.TemperatureC != nil {
		fahrenheit := CelsiusToFahrenheit(*in.TemperatureC)
		live.TemperatureF = wired(&fahrenheit)
		// Compared in Celsius, the unit the sensor reports and the threshold is set in.
		live.OverTemperature = *in.TemperatureC >= temp
	}
	if apparent != nil {
		percent := *apparent / load * 100
		headroom := load - *apparent
		live.LoadPercent = wired(&percent)
		live.HeadroomVA = wired(&headroom)
	}
	if f.connected {
		live.DeviceIP = deviceIP
	}
	return live
}

// isSampleDue is the cheap early exit before recording a simulator sample: true when
// there is no simulator row yet or the newest one is at least an interval old.
//
// latestSimulatorMs comes from strftime('%s') and so is whole seconds; it can judge a
// sample due up to a second early. Harmless, since recordSampleSQL decides for real.
func isSampleDue(latestSimulatorMs *int64, sampleIntervalMs int64, now time.Time) bool {
	return latestSimulatorMs == nil || now.UnixMilli()-*latestSimulatorMs >= sampleIntervalMs
}

// sampleWindowModifier renders the interval as the SQLite date modifier
// recordSampleSQL binds, with milliseconds ("-15.000 seconds") so an interval that is
// not a whole number of seconds still lands where it was configured. Negative
// intervals count as zero.
func sampleWindowModifier(sampleIntervalMs int64) string {
	ms := max(sampleIntervalMs, 0)
	return fmt.Sprintf("-%d.%03d seconds", ms/1000, ms%1000)
}
