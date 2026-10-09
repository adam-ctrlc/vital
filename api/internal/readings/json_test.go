package readings

import (
	"encoding/json"
	"math"
	"testing"
	"time"

	"github.com/adam-ctrlc/vital/api/internal/device"
	"github.com/adam-ctrlc/vital/api/internal/wire"
)

// The expected strings below are what serde_json produced for the Rust structs with
// the same values, so field names, order, nulls, float and timestamp formatting all
// match byte for byte.

func mustJSON(t *testing.T, v any) string {
	t.Helper()
	b, err := json.Marshal(v)
	if err != nil {
		t.Fatal(err)
	}
	return string(b)
}

func TestLiveReadingJSONMatchesRust(t *testing.T) {
	now := time.UnixMilli(1_791_504_000_123).Add(456_789 * time.Nanosecond)
	live := newLiveReading(
		resolveFeed("simulation", nil, now),
		testSettings(),
		ptr("192.168.1.40"), // dropped: a simulated feed is never connected
	)
	want := `{"voltageV":228.54773314379088,"currentA":2.880442472831321,"temperatureC":37.742781555484854,"temperatureF":99.93700679987273,"apparentPowerVa":658.3185976166939,"status":"normal","loadThresholdVa":900.0,"tripThresholdVa":1000.0,"tempThresholdC":40.0,"tempThresholdF":104.0,"loadPercent":73.14651084629932,"overTemperature":false,"powerW":560.6466515005383,"powerFactor":0.8516342292778046,"frequencyHz":59.95690167937673,"energyKwh":1544.4000222083334,"reactivePowerVar":345.0488489029408,"headroomVa":241.68140238330614,"recordedAt":"2026-10-09T00:00:00.123456789Z","simulated":true,"connected":false,"relayClosed":null,"deviceIp":null}`
	if got := mustJSON(t, live); got != want {
		t.Fatalf("got  %s\nwant %s", got, want)
	}
}

func sampleReading() Reading {
	return Reading{
		ID:           42,
		VoltageV:     wire.Ptr(230),
		TemperatureC: wire.Ptr(31.5),
		Status:       "normal",
		Source:       "hardware",
		PowerFactor:  wire.Ptr(0.9),
		EnergyKwh:    wire.Ptr(1e16),
		RelayClosed:  ptr(false),
		// Recorded under the limits it was judged against.
		LoadThresholdVA: wire.Ptr(500),
		TripThresholdVA: wire.Ptr(900),
		TempThresholdC:  wire.Ptr(70),
		RecordedAt:      stamp(time.UnixMilli(1_791_504_000_120)),
	}
}

func TestIngestAckJSON(t *testing.T) {
	const reading = `{"id":42,"voltageV":230.0,"currentA":null,"temperatureC":31.5,"apparentPowerVa":null,"status":"normal","source":"hardware","powerW":null,"powerFactor":0.9,"frequencyHz":null,"energyKwh":1e+16,"relayClosed":false,"loadThresholdVa":500.0,"tripThresholdVa":900.0,"tempThresholdC":70.0,"recordedAt":"2026-10-09T00:00:00.120Z"`
	tests := []struct {
		pending device.Pending
		want    string
	}{
		{device.Pending{}, reading + `,"relayCommand":null,"relayCommandId":null}`},
		{device.Pending{Command: device.CommandOpen, ID: 3}, reading + `,"relayCommand":"open","relayCommandId":3}`},
	}
	for _, tt := range tests {
		ack := IngestAck{Reading: sampleReading(), RelayCommand: tt.pending.Command, RelayCommandID: tt.pending.IDOrNil()}
		if got := mustJSON(t, ack); got != tt.want {
			t.Errorf("got  %s\nwant %s", got, tt.want)
		}
	}
}

func TestTrendJSONMatchesRust(t *testing.T) {
	points := []TrendPoint{{
		Day:             stamp(time.Unix(1_791_504_000, 0)),
		AvgPowerVA:      wire.Ptr(712.5),
		AvgTemperatureC: wire.Ptr(math.NaN()), // serde writes a non-finite float as null
		Samples:         3,
	}}
	want := `[{"day":"2026-10-09T00:00:00Z","avgPowerVa":712.5,"maxPowerVa":null,"avgTemperatureC":null,"samples":3}]`
	if got := mustJSON(t, points); got != want {
		t.Fatalf("got  %s\nwant %s", got, want)
	}
}

func TestInputDecodesCamelCase(t *testing.T) {
	var in Input
	body := `{"voltageV":230,"currentA":null,"temperatureC":31.5,"powerW":800,"powerFactor":0.9,"frequencyHz":60,"energyKwh":1.5,"relayClosed":true,"unknown":1}`
	if err := json.Unmarshal([]byte(body), &in); err != nil {
		t.Fatal(err)
	}
	if *in.VoltageV != 230 || in.CurrentA != nil || *in.TemperatureC != 31.5 || *in.PowerW != 800 ||
		*in.PowerFactor != 0.9 || *in.FrequencyHz != 60 || *in.EnergyKwh != 1.5 || !*in.RelayClosed {
		t.Fatalf("decoded %+v", in)
	}
}
