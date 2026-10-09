package readings

import (
	"strconv"
	"strings"
	"testing"
)

func TestReadingColumnsMatchTheStruct(t *testing.T) {
	// One column per Reading field, decoded positionally.
	if got := len(strings.Split(readingColumns, ",")); got != 16 {
		t.Fatalf("readingColumns has %d columns, want 16", got)
	}
}

func TestHistoryFilterEscapesEveryLike(t *testing.T) {
	// SQLite has no default LIKE escape, so every clause must declare one or a needle
	// of "50%" goes back to meaning "anything".
	likes := strings.Count(historyFilter, " like ")
	escapes := strings.Count(historyFilter, `escape '\'`)
	if likes != 4 || escapes != likes {
		t.Fatalf("%d likes, %d escapes", likes, escapes)
	}
}

func TestStatementsBindWhatTheirCallersPass(t *testing.T) {
	tests := []struct {
		name string
		sql  string
		max  int
	}{
		{"insert", insertReadingSQL, 14},
		{"record sample", recordSampleSQL, 14},
		{"history count", historyCountSQL, 8},
		{"history select", HistoryFilter{}.SelectSQL(), 10},
		{"trend", trendSQL, 1},
		{"latest hardware", latestHardwareSQL, 0},
		{"live state", liveStateSQL, 0},
	}
	for _, tt := range tests {
		highest := 0
		for i := 1; i <= 16; i++ {
			if strings.Contains(tt.sql, "?"+strconv.Itoa(i)) {
				highest = i
			}
		}
		if highest != tt.max {
			t.Errorf("%s: highest placeholder ?%d, want ?%d", tt.name, highest, tt.max)
		}
	}
}
