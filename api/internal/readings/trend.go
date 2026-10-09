package readings

import "fmt"

// Trend window bounds, in days.
const (
	defaultTrendDays int64 = 7
	minTrendDays     int64 = 1
	maxTrendDays     int64 = 90
)

// trendDays resolves the ?days parameter: 7 when absent, held to [1, 90].
func trendDays(days *int64) int64 {
	if days == nil {
		return defaultTrendDays
	}
	return min(max(*days, minTrendDays), maxTrendDays)
}

// trendWindowModifier is the SQLite date modifier trendSQL binds as ?1.
func trendWindowModifier(days int64) string {
	return fmt.Sprintf("-%d days", days)
}
