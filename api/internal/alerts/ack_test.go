package alerts

import (
	"testing"
	"time"
)

func TestResponseMillis(t *testing.T) {
	ts := func(raw string) time.Time {
		v, err := time.Parse(time.RFC3339Nano, raw)
		if err != nil {
			t.Fatal(err)
		}
		return v
	}
	tests := []struct {
		name           string
		created, acked string
		want           int64
	}{
		{"three minutes", "2026-08-14T05:00:00.000Z", "2026-08-14T05:03:00.000Z", 180000},
		{"fractions are floored on both sides", "2026-08-14T05:00:00.999Z", "2026-08-14T05:00:01.001Z", 1000},
		{"under a second within one second", "2026-08-14T05:00:00.050Z", "2026-08-14T05:00:00.950Z", 0},
		{"offsets are honoured", "2026-08-14T13:00:00+08:00", "2026-08-14T05:00:10Z", 10000},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			if got := responseMillis(ts(tt.created), ts(tt.acked)); got != tt.want {
				t.Errorf("got %d, want %d", got, tt.want)
			}
		})
	}
}
