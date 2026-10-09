package readings

import "math"

const (
	nominalVoltage = 230.0
	// nominalFrequency is the Philippine grid's 60 Hz.
	nominalFrequency = 60.0
	// energyEpochMs is the fixed point the simulated meter counts up from:
	// 2026-07-01T00:00:00Z.
	energyEpochMs int64 = 1_782_950_400_000
	// meanPowerKw is the rough mean real power used to accumulate the energy total.
	meanPowerKw = 0.65
)

// Simulate derives a smooth, repeatable measurement from the clock.
//
// Serverless functions cannot keep a background loop alive, so the value is a pure
// function of time. It drifts across the 900 VA and 40 C thresholds so the dashboard,
// alerts and logs all exercise realistically without any stored simulator state.
//
// Every product is converted to float64 before it is added. The Go spec lets the
// compiler fuse x*y + z into one rounding (arm64 does), and the Rust original never
// fuses, so without the conversions the last bit would differ.
func Simulate(unixMs int64) Input {
	t := float64(unixMs) / 1000

	apparent := 720 +
		float64(190*math.Sin(t/37)) +
		float64(70*math.Sin(t/11.3)) +
		float64(18*math.Sin(t/2.7))
	apparent = clamp(apparent, 0, 1400)

	voltage := nominalVoltage + float64(2.5*math.Sin(t/6.1)) + float64(1.2*math.Sin(t/1.7))
	current := apparent / voltage

	temperature := 34 + float64(7*math.Sin(t/53)) + float64(1.5*math.Sin(t/4.3))

	// An inductive load drifting through the range a transformer study cares about.
	powerFactor := clamp(0.90+float64(0.05*math.Sin(t/23)), 0, 1)
	power := apparent * powerFactor

	frequency := nominalFrequency + float64(0.05*math.Sin(t/17))

	// Monotonic, like a real meter's running total.
	hours := float64(max(unixMs-energyEpochMs, 0)) / 3_600_000
	energy := hours * meanPowerKw

	return Input{
		VoltageV:     &voltage,
		CurrentA:     &current,
		TemperatureC: &temperature,
		PowerW:       &power,
		PowerFactor:  &powerFactor,
		FrequencyHz:  &frequency,
		EnergyKwh:    &energy,
		// The simulator has no contacts. Null rather than a guess, so a simulated run
		// never claims a relay position that no relay held.
		RelayClosed: nil,
	}
}

// clamp is Rust's f64::clamp: NaN passes through unchanged.
func clamp(v, lo, hi float64) float64 {
	if v < lo {
		return lo
	}
	if v > hi {
		return hi
	}
	return v
}
