package readings

import "testing"

// TestStoredInstant pins the accepted shapes to what chrono 0.4.45's
// parse_from_rfc3339 and %.3f produced for the same input.
func TestStoredInstant(t *testing.T) {
	tests := []struct {
		raw  string
		want string // empty means rejected
	}{
		// an_instant_is_rewritten_in_the_stored_shape
		{"2026-10-09T00:00:00+08:00", "2026-10-08T16:00:00.000Z"},
		{"2026-10-09t00:00:00z", "2026-10-09T00:00:00.000Z"},
		{"2026-10-09 00:00:00Z", "2026-10-09T00:00:00.000Z"},
		{"2026-10-09T00:00:00-00:00", "2026-10-09T00:00:00.000Z"},
		{"2026-10-09T00:00:00.1234567891Z", "2026-10-09T00:00:00.123Z"},
		{"2026-10-09T00:00:00.9999Z", "2026-10-09T00:00:00.999Z"},
		{"0000-01-01T00:00:00Z", "0000-01-01T00:00:00.000Z"},
		{"2026-10-09T00:00:00", ""},
		{"2026-10-09T00:00:00+0800", ""},
		{"2026-10-09T24:00:00Z", ""},
		{"2026-10-09T00:00:00.Z", ""},
		{"2026-10-09T00:00:00,5Z", ""},
		{"2026-02-30T00:00:00Z", ""},
		{"yesterday", ""},
	}
	for _, tt := range tests {
		t.Run(tt.raw, func(t *testing.T) {
			got, err := storedInstant(tt.raw)
			if tt.want == "" {
				if err == nil {
					t.Fatalf("storedInstant = %q, want an error", got)
				}
				return
			}
			if err != nil || got != tt.want {
				t.Fatalf("storedInstant = %q, %v, want %q", got, err, tt.want)
			}
		})
	}
}
