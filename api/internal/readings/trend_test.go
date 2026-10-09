package readings

import "testing"

func TestTrendDays(t *testing.T) {
	tests := []struct {
		days *int64
		want int64
	}{
		{nil, 7},
		{ptr[int64](30), 30},
		{ptr[int64](0), 1},
		{ptr[int64](-4), 1},
		{ptr[int64](365), 90},
	}
	for _, tt := range tests {
		if got := trendDays(tt.days); got != tt.want {
			t.Errorf("trendDays(%v) = %d, want %d", tt.days, got, tt.want)
		}
	}
	if got := trendWindowModifier(7); got != "-7 days" {
		t.Errorf("trendWindowModifier(7) = %q", got)
	}
}
