package readings

import (
	"math"
	"testing"
	"time"

	"github.com/adam-ctrlc/vital/api/internal/settings"
	"github.com/adam-ctrlc/vital/api/internal/wire"
)

func TestEvaluate(t *testing.T) {
	tests := []struct {
		name     string
		in       Input
		apparent *float64
		status   Status
	}{
		{"under", Input{VoltageV: ptr(230.0), CurrentA: ptr(3.0)}, ptr(690.0), StatusNormal},
		{"at the threshold is overload", Input{VoltageV: ptr(225.0), CurrentA: ptr(4.0)}, ptr(900.0), StatusOverload},
		{"over", Input{VoltageV: ptr(230.0), CurrentA: ptr(4.0)}, ptr(920.0), StatusOverload},
		{"no current", Input{VoltageV: ptr(230.0), TemperatureC: ptr(90.0)}, nil, StatusNormal},
		{"no voltage", Input{CurrentA: ptr(40.0)}, nil, StatusNormal},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			apparent, status := Evaluate(tt.in, 900)
			if status != tt.status {
				t.Errorf("status = %s, want %s", status, tt.status)
			}
			if (apparent == nil) != (tt.apparent == nil) || (apparent != nil && *apparent != *tt.apparent) {
				t.Errorf("apparent = %v, want %v", apparent, tt.apparent)
			}
		})
	}
}

func TestReactivePower(t *testing.T) {
	if q := ReactivePower(ptr(500.0), ptr(400.0)); q == nil || *q != 300 {
		t.Errorf("3-4-5 triangle: got %v", q)
	}
	// Sensor noise can put P marginally above S; Q is clamped at zero, not NaN.
	if q := ReactivePower(ptr(500.0), ptr(500.1)); q == nil || *q != 0 {
		t.Errorf("P > S: got %v", q)
	}
	if q := ReactivePower(nil, ptr(1.0)); q != nil {
		t.Errorf("no apparent power: got %v", *q)
	}
	if q := ReactivePower(ptr(1.0), nil); q != nil {
		t.Errorf("no real power: got %v", *q)
	}
}

// TestDerivedMatchesRust pins apparent power, load percent, reactive power, headroom
// and Fahrenheit to the bits the Rust service computed for the same simulated input
// against a 900 VA, 40 C threshold.
func TestDerivedMatchesRust(t *testing.T) {
	golden := map[int64][5]uint64{
		1_791_504_000_000: {0x4084906eb75da495, 0x4052477edbe175d9, 0x40758fb60a0ec1c5, 0x406e3e4522896dac, 0x4058f9c305d1963a},
		1_800_000_000_999: {0x4081b395c4ad3746, 0x404f7826b2fb0cee, 0x40661c03e9845d78, 0x4074d8d476a59174, 0x405a8594c0f671c1},
	}
	for ms, want := range golden {
		live := newLiveReading(resolveFeed("simulation", nil, time.UnixMilli(ms)), testSettings(), nil)
		got := [5]*wire.Float{live.ApparentPowerVA, live.LoadPercent, live.ReactivePowerVar, live.HeadroomVA, live.TemperatureF}
		for i, g := range got {
			if bits := math.Float64bits(float64(*g)); bits != want[i] {
				t.Errorf("at %d value %d = %#016x, Rust gave %#016x", ms, i, bits, want[i])
			}
		}
	}
}

func testSettings() settings.Settings {
	return settings.Settings{LoadThresholdVA: 900, TripThresholdVA: 1000, TempThresholdC: 40, SourceMode: "simulation"}
}

func hardwareReading(recordedAt time.Time) *Reading {
	return &Reading{
		ID: 7, VoltageV: wire.Ptr(230), CurrentA: wire.Ptr(4), TemperatureC: wire.Ptr(41),
		Status: "overload", Source: "hardware", RelayClosed: ptr(true), RecordedAt: stamp(recordedAt),
	}
}

func TestLiveHardwareFeed(t *testing.T) {
	now := time.Date(2026, 10, 9, 0, 1, 0, 0, time.UTC)
	thresholds := testSettings()
	ip := ptr("192.168.1.40")

	t.Run("fresh reading is served and connected", func(t *testing.T) {
		recorded := now.Add(-10 * time.Second)
		live := newLiveReading(resolveFeed("hardware", hardwareReading(recorded), now), thresholds, ip)
		if !live.Connected || live.Simulated {
			t.Fatalf("connected=%v simulated=%v", live.Connected, live.Simulated)
		}
		if !live.RecordedAt.Equal(recorded) {
			t.Errorf("recordedAt = %v, want the reading's own %v", live.RecordedAt, recorded)
		}
		if live.Status != StatusOverload || float64(*live.ApparentPowerVA) != 920 || float64(*live.HeadroomVA) != -20 {
			t.Errorf("status %s, apparent %v, headroom %v", live.Status, *live.ApparentPowerVA, *live.HeadroomVA)
		}
		if !live.OverTemperature || live.RelayClosed == nil || !*live.RelayClosed {
			t.Errorf("overTemperature %v, relayClosed %v", live.OverTemperature, live.RelayClosed)
		}
		if live.DeviceIP == nil || *live.DeviceIP != *ip {
			t.Errorf("deviceIp = %v, want the board's address while connected", live.DeviceIP)
		}
		if live.ReactivePowerVar != nil {
			t.Errorf("reactive power without real power: %v", *live.ReactivePowerVar)
		}
	})

	for name, latest := range map[string]*Reading{
		"stale reading": hardwareReading(now.Add(-31 * time.Second)),
		"no reading":    nil,
	} {
		t.Run(name+" reads as no data", func(t *testing.T) {
			live := newLiveReading(resolveFeed("hardware", latest, now), thresholds, ip)
			if live.Connected || live.Simulated || live.DeviceIP != nil || live.RelayClosed != nil {
				t.Fatalf("connected=%v simulated=%v deviceIp=%v relay=%v", live.Connected, live.Simulated, live.DeviceIP, live.RelayClosed)
			}
			if live.VoltageV != nil || live.ApparentPowerVA != nil || live.LoadPercent != nil || live.TemperatureF != nil {
				t.Fatal("a quiet board still served measurements")
			}
			if live.Status != StatusNormal || live.OverTemperature {
				t.Fatalf("status %s, overTemperature %v", live.Status, live.OverTemperature)
			}
			if !live.RecordedAt.Equal(now) {
				t.Fatalf("recordedAt = %v, want now", live.RecordedAt)
			}
			if float64(live.TempThresholdF) != 104 || float64(live.TripThresholdVA) != 1000 {
				t.Fatal("thresholds missing from an empty feed")
			}
		})
	}
}

func TestLiveSimulatedFeedIgnoresHardware(t *testing.T) {
	now := time.Date(2026, 10, 9, 0, 1, 0, 0, time.UTC)
	f := resolveFeed("simulation", hardwareReading(now), now)
	if !f.simulated || f.connected || f.input.RelayClosed != nil {
		t.Fatalf("feed = %+v", f)
	}
}

func TestIsSampleDue(t *testing.T) {
	now := time.UnixMilli(1_791_504_015_000)
	tests := []struct {
		name   string
		latest *int64
		want   bool
	}{
		{"no simulator row yet", nil, true},
		{"exactly an interval old", ptr[int64](1_791_504_000_000), true},
		{"just under", ptr[int64](1_791_504_000_001), false},
		{"long ago", ptr[int64](0), true},
	}
	for _, tt := range tests {
		if got := isSampleDue(tt.latest, 15_000, now); got != tt.want {
			t.Errorf("%s: got %v, want %v", tt.name, got, tt.want)
		}
	}
}

func TestSampleWindowModifier(t *testing.T) {
	tests := map[int64]string{
		15_000: "-15.000 seconds",
		1_500:  "-1.500 seconds",
		7:      "-0.007 seconds",
		0:      "-0.000 seconds",
		-500:   "-0.000 seconds",
	}
	for ms, want := range tests {
		if got := sampleWindowModifier(ms); got != want {
			t.Errorf("sampleWindowModifier(%d) = %q, want %q", ms, got, want)
		}
	}
}
