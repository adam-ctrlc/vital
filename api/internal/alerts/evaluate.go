package alerts

import (
	"math"
	"strconv"
)

// Measurement is what alert evaluation needs from a stored reading. A nil field was
// not reported and cannot raise anything.
//
// Defined here rather than taken from the readings package so that package can call
// Evaluate without an import cycle.
type Measurement struct {
	ReadingID       int64
	ApparentPowerVA *float64
	TemperatureC    *float64
}

// Thresholds are the settings alert evaluation compares against.
type Thresholds struct {
	// LoadVA raises an overload alert. Advisory: nothing is switched.
	LoadVA float64
	// TempC raises a temperature alert.
	TempC float64
}

// Condition is one threshold a reading crossed: what an alert would be opened with.
type Condition struct {
	Kind      Kind
	Message   string
	Value     float64
	Threshold float64
}

// Conditions returns the thresholds m crosses, overload before temperature. A value
// equal to its threshold crosses it. NaN crosses nothing.
func Conditions(m Measurement, t Thresholds) []Condition {
	var out []Condition

	if v := m.ApparentPowerVA; v != nil && *v >= t.LoadVA {
		out = append(out, Condition{
			Kind:      KindOverload,
			Message:   "Load reached " + formatFixed(*v, 0) + " VA",
			Value:     *v,
			Threshold: t.LoadVA,
		})
	}

	if v := m.TemperatureC; v != nil && *v >= t.TempC {
		out = append(out, Condition{
			Kind:      KindTemperature,
			Message:   "Temperature reached " + formatFixed(*v, 1) + " °C",
			Value:     *v,
			Threshold: t.TempC,
		})
	}

	return out
}

// formatFixed renders v with prec decimals as Rust's {:.N} does: round half to even
// on the exact binary value (as strconv does), and inf, -inf and NaN spelled the Rust
// way rather than Go's +Inf.
func formatFixed(v float64, prec int) string {
	switch {
	case math.IsInf(v, 1):
		return "inf"
	case math.IsInf(v, -1):
		return "-inf"
	case math.IsNaN(v):
		return "NaN"
	}
	return strconv.FormatFloat(v, 'f', prec, 64)
}
