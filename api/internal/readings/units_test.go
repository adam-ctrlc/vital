package readings

import (
	"math"
	"testing"
)

// close compares floats within a tolerance, since fixed points do not compare exactly.
func close(a, b float64) bool { return math.Abs(a-b) < 1e-9 }

func TestCelsiusToFahrenheit(t *testing.T) {
	tests := []struct {
		name    string
		celsius float64
		want    float64
	}{
		// converts_the_known_fixed_points
		{"water freezes", 0, 32},
		{"water boils", 100, 212},
		{"body temperature", 37, 98.6},
		{"both scales agree", -40, -40},
		// converts_the_alarm_threshold
		{"alarm threshold", 40, 104},
	}
	for _, tt := range tests {
		if got := CelsiusToFahrenheit(tt.celsius); !close(got, tt.want) {
			t.Errorf("%s: CelsiusToFahrenheit(%v) = %v, want %v", tt.name, tt.celsius, got, tt.want)
		}
	}
}

// round_trips_without_drifting
func TestTemperatureRoundTrip(t *testing.T) {
	for step := -50; step < 150; step++ {
		c := float64(step)
		if got := FahrenheitToCelsius(CelsiusToFahrenheit(c)); !close(got, c) {
			t.Errorf("drifted at %v C: got %v", c, got)
		}
	}
}
