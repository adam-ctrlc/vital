package readings

import (
	"math"
	"testing"
)

// rangeOf finds an ingest envelope by its field name.
func rangeOf(t *testing.T, field string) measurementRange {
	t.Helper()
	for _, c := range ingestChecks(Input{}) {
		if c.field == field {
			return c.measurementRange
		}
	}
	t.Fatalf("no range for %q", field)
	return measurementRange{}
}

func TestMeasurementRange(t *testing.T) {
	tests := []struct {
		name  string
		field string
		value *float64
		ok    bool
	}{
		// an_absent_measurement_is_always_accepted
		{"absent", "voltage", nil, true},
		// a_plausible_measurement_is_accepted
		{"mains voltage", "voltage", ptr(230.1), true},
		{"idle current", "current", ptr(0.0), true},
		{"cold probe", "temperature", ptr(-10.0), true},
		{"bounds are inclusive", "power factor", ptr(1.0), true},
		// the_pair_that_multiplied_to_infinity_is_rejected
		{"huge voltage", "voltage", ptr(1e200), false},
		{"huge current", "current", ptr(1e200), false},
		// an_absurd_temperature_is_rejected
		{"absurd temperature", "temperature", ptr(999_999.0), false},
		// a_negative_measurement_is_still_rejected
		{"negative voltage", "voltage", ptr(-1.0), false},
		{"negative current", "current", ptr(-1.0), false},
		// a_non_finite_measurement_is_rejected
		{"NaN", "voltage", ptr(math.NaN()), false},
		{"infinity", "voltage", ptr(math.Inf(1)), false},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			err := rangeOf(t, tt.field).check(tt.value)
			if tt.ok {
				if err != nil {
					t.Fatalf("check = %v, want ok", err)
				}
				return
			}
			wantBadRequest(t, err, "")
		})
	}
}

func TestValidateIngest(t *testing.T) {
	tests := []struct {
		name string
		in   Input
		msg  string // empty means valid
	}{
		{"nothing measured", Input{}, "at least one measurement is required"},
		{"relay only", Input{RelayClosed: ptr(true)}, "at least one measurement is required"},
		{"probe only", Input{TemperatureC: ptr(31.5)}, ""},
		{"full board", Input{
			VoltageV: ptr(230.0), CurrentA: ptr(3.9), PowerW: ptr(800.0), TemperatureC: ptr(35.0),
			FrequencyHz: ptr(60.0), EnergyKwh: ptr(12.0), PowerFactor: ptr(0.9), RelayClosed: ptr(true),
		}, ""},
		// The messages render bounds as Rust's f64 Display did.
		{"voltage", Input{VoltageV: ptr(1e200)}, "voltage must be between 0 and 1000"},
		{"current", Input{CurrentA: ptr(-1.0)}, "current must be between 0 and 100"},
		{"power", Input{PowerW: ptr(-1e6)}, "power must be between -100000 and 100000"},
		{"temperature", Input{TemperatureC: ptr(999_999.0)}, "temperature must be between -50 and 300"},
		{"frequency", Input{FrequencyHz: ptr(101.0)}, "frequency must be between 0 and 100"},
		{"energy", Input{EnergyKwh: ptr(-0.5)}, "energy must be between 0 and 1000000"},
		{"power factor", Input{PowerFactor: ptr(1.01)}, "power factor must be between 0 and 1"},
		// First failure wins, in the Rust route's order: voltage before temperature.
		{"order", Input{VoltageV: ptr(-1.0), TemperatureC: ptr(999.0)}, "voltage must be between 0 and 1000"},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			err := ValidateIngest(tt.in)
			if tt.msg == "" {
				if err != nil {
					t.Fatalf("ValidateIngest = %v, want ok", err)
				}
				return
			}
			wantBadRequest(t, err, tt.msg)
		})
	}
}
