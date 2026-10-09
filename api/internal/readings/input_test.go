package readings

import "testing"

func TestInputIsEmpty(t *testing.T) {
	tests := []struct {
		name string
		in   Input
		want bool
	}{
		// an_input_with_nothing_in_it_is_empty
		{"nothing in it", Input{}, true},
		// a_single_measurement_is_enough: a board with only a probe still reports.
		{"probe only", Input{TemperatureC: ptr(31.5)}, false},
		{"energy only", Input{EnergyKwh: ptr(12.5)}, false},
		{"voltage only", Input{VoltageV: ptr(230.0)}, false},
		{"current only", Input{CurrentA: ptr(1.0)}, false},
		{"power only", Input{PowerW: ptr(1.0)}, false},
		{"power factor only", Input{PowerFactor: ptr(0.9)}, false},
		{"frequency only", Input{FrequencyHz: ptr(60.0)}, false},
		// a_relay_position_on_its_own_is_still_empty
		{"relay only", Input{RelayClosed: ptr(true)}, true},
		{"tripped under load", Input{CurrentA: ptr(4.2), RelayClosed: ptr(false)}, false},
		// a_zero_is_a_measurement_not_an_absence
		{"idle zero amps", Input{CurrentA: ptr(0.0)}, false},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			if got := tt.in.IsEmpty(); got != tt.want {
				t.Errorf("IsEmpty() = %v, want %v", got, tt.want)
			}
		})
	}
}

func TestParseStatus(t *testing.T) {
	for _, ok := range []string{"normal", "overload"} {
		if got, err := ParseStatus(ok); err != nil || string(got) != ok {
			t.Errorf("ParseStatus(%q) = %q, %v", ok, got, err)
		}
	}
	_, err := ParseStatus("Overload")
	wantBadRequest(t, err, "invalid status: Overload")
}
