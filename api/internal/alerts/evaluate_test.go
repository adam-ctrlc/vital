package alerts

import (
	"math"
	"reflect"
	"testing"
)

func f(v float64) *float64 { return &v }

func TestConditions(t *testing.T) {
	limits := Thresholds{LoadVA: 900, TempC: 40}

	tests := []struct {
		name string
		m    Measurement
		want []Condition
	}{
		{name: "nothing reported", m: Measurement{ReadingID: 1}},
		{name: "below both", m: Measurement{ApparentPowerVA: f(899.9), TemperatureC: f(39.9)}},
		{
			name: "load at the threshold crosses it",
			m:    Measurement{ApparentPowerVA: f(900)},
			want: []Condition{{KindOverload, "Load reached 900 VA", 900, 900}},
		},
		{
			name: "load rounds to whole VA, half to even",
			m:    Measurement{ApparentPowerVA: f(950.5)},
			want: []Condition{{KindOverload, "Load reached 950 VA", 950.5, 900}},
		},
		{
			name: "load rounds up",
			m:    Measurement{ApparentPowerVA: f(912.7)},
			want: []Condition{{KindOverload, "Load reached 913 VA", 912.7, 900}},
		},
		{
			name: "temperature at the threshold, one decimal",
			m:    Measurement{TemperatureC: f(40)},
			want: []Condition{{KindTemperature, "Temperature reached 40.0 °C", 40, 40}},
		},
		{
			name: "temperature rounds on the binary value",
			m:    Measurement{TemperatureC: f(40.25)},
			want: []Condition{{KindTemperature, "Temperature reached 40.2 °C", 40.25, 40}},
		},
		{
			name: "both, overload first",
			m:    Measurement{ApparentPowerVA: f(1000), TemperatureC: f(55.55)},
			want: []Condition{
				{KindOverload, "Load reached 1000 VA", 1000, 900},
				{KindTemperature, "Temperature reached 55.5 °C", 55.55, 40},
			},
		},
		{
			name: "only temperature crosses",
			m:    Measurement{ApparentPowerVA: f(10), TemperatureC: f(41)},
			want: []Condition{{KindTemperature, "Temperature reached 41.0 °C", 41, 40}},
		},
		{name: "NaN crosses nothing", m: Measurement{ApparentPowerVA: f(math.NaN()), TemperatureC: f(math.NaN())}},
		{
			name: "infinity crosses and renders the Rust way",
			m:    Measurement{ApparentPowerVA: f(math.Inf(1))},
			want: []Condition{{KindOverload, "Load reached inf VA", math.Inf(1), 900}},
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			if got := Conditions(tt.m, limits); !reflect.DeepEqual(got, tt.want) {
				t.Errorf("got %+v, want %+v", got, tt.want)
			}
		})
	}
}

// Expected strings are what rustc 1.x prints for format!("{v:.N}").
func TestFormatFixedMatchesRust(t *testing.T) {
	tests := []struct {
		v    float64
		prec int
		want string
	}{
		{0.5, 0, "0"},
		{1.5, 0, "2"},
		{2.5, 0, "2"},
		{899.5, 0, "900"},
		{900.5, 0, "900"},
		{-0.4, 0, "-0"},
		{1e21, 0, "1000000000000000000000"},
		{0.25, 1, "0.2"},
		{0.35, 1, "0.3"},
		{40.05, 1, "40.0"},
		{40.15, 1, "40.1"},
		{1e16, 1, "10000000000000000.0"},
		{math.Inf(1), 0, "inf"},
		{math.Inf(-1), 1, "-inf"},
		{math.NaN(), 1, "NaN"},
	}
	for _, tt := range tests {
		if got := formatFixed(tt.v, tt.prec); got != tt.want {
			t.Errorf("formatFixed(%v, %d) = %q, want %q", tt.v, tt.prec, got, tt.want)
		}
	}
}
