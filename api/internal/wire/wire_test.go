package wire

import (
	"encoding/json"
	"math"
	"testing"
	"time"
)

// Expected values were produced by serde_json 1.0.150, the version the Rust API
// ships, so this pins the Go output to what clients already parse.
func TestFormatFloatMatchesSerdeJSON(t *testing.T) {
	tests := []struct {
		in   float64
		want string
	}{
		{0, "0.0"},
		{math.Copysign(0, -1), "-0.0"},
		{1, "1.0"},
		{900, "900.0"},
		{0.1, "0.1"},
		{1e15, "1000000000000000.0"},
		{1e16, "1e+16"},
		{1e17, "1e+17"},
		{123456789012345680, "1.2345678901234568e+17"},
		{1234567890123456.7, "1234567890123456.8"},
		{12345678901234567, "1.2345678901234568e+16"},
		{1e-4, "0.0001"},
		{1e-5, "0.00001"},
		{1e-6, "1e-6"},
		{1e-7, "1e-7"},
		{1.5e-7, "1.5e-7"},
		{0.000123, "0.000123"},
		{1.5e300, "1.5e+300"},
		{5e-324, "5e-324"},
		{1e21, "1e+21"},
		{-230.5, "-230.5"},
		{2.5e-5, "0.000025"},
		{99999999999999990, "9.999999999999998e+16"},
		{230.12345, "230.12345"},
		{math.NaN(), "null"},
		{math.Inf(1), "null"},
	}

	for _, tt := range tests {
		if got := FormatFloat(tt.in); got != tt.want {
			t.Errorf("FormatFloat(%v) = %q, want %q", tt.in, got, tt.want)
		}
	}
}

func TestTimeMatchesChrono(t *testing.T) {
	tests := []struct {
		raw  string
		want string
	}{
		{"2026-08-14T05:00:00.000Z", `"2026-08-14T05:00:00Z"`},
		{"2026-08-14T05:00:00.120Z", `"2026-08-14T05:00:00.120Z"`},
		{"2026-08-14T05:00:00.123456Z", `"2026-08-14T05:00:00.123456Z"`},
		{"2026-08-14T05:00:00.123456789Z", `"2026-08-14T05:00:00.123456789Z"`},
		{"2026-08-14T13:00:00.5+08:00", `"2026-08-14T05:00:00.500Z"`},
	}

	for _, tt := range tests {
		parsed, err := ParseTime(tt.raw)
		if err != nil {
			t.Fatalf("ParseTime(%q): %v", tt.raw, err)
		}
		got, err := json.Marshal(Time{parsed})
		if err != nil {
			t.Fatal(err)
		}
		if string(got) != tt.want {
			t.Errorf("Time(%q) = %s, want %s", tt.raw, got, tt.want)
		}
	}
}

func TestParseTimeRejectsSQLiteDatetime(t *testing.T) {
	// datetime('now') has no T and no zone; chrono refused it, so must this.
	if _, err := ParseTime("2026-08-14 05:00:00"); err == nil {
		t.Fatal("expected an error")
	}
}

func TestLocalLabel(t *testing.T) {
	at := time.Date(2026, 8, 14, 5, 7, 0, 0, time.UTC)
	if got, want := LocalLabel(at), "August 14, 2026 1:07 PM"; got != want {
		t.Errorf("LocalLabel = %q, want %q", got, want)
	}
}

func TestFormatStorage(t *testing.T) {
	at := time.Date(2026, 8, 14, 5, 0, 0, 7_000_000, time.UTC)
	if got, want := FormatStorage(at), "2026-08-14T05:00:00.007Z"; got != want {
		t.Errorf("FormatStorage = %q, want %q", got, want)
	}
}
