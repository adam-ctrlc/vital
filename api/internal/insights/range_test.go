package insights

import (
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/adam-ctrlc/vital/api/internal/httpx"
)

func rangeOf(t *testing.T, query string, now string) (Range, error) {
	t.Helper()
	r := httptest.NewRequest("GET", "/api/v1/insights?"+query, nil)
	return parseRange(httpx.NewQuery(r), utc(now))
}

func TestDefaultRangeIsTheLastWeekInManila(t *testing.T) {
	// 16:30 UTC on the 8th is already 00:30 on the 9th in Manila.
	r, err := rangeOf(t, "", "2026-10-08T16:30:00Z")
	if err != nil {
		t.Fatal(err)
	}
	if got := r.From.Format(dateLayout) + ".." + r.To.Format(dateLayout); got != "2026-10-03..2026-10-09" {
		t.Errorf("range = %s", got)
	}
	if r.Source != "hardware" || r.Days() != 7 {
		t.Errorf("source %s, days %d", r.Source, r.Days())
	}
	if got := storage(r.Start()) + " " + storage(r.End()); got != "2026-10-02T16:00:00.000Z 2026-10-09T16:00:00.000Z" {
		t.Errorf("bounds = %s", got)
	}
	// Only `to` given: the week ending then.
	r, _ = rangeOf(t, "to=2026-09-24", "2026-10-08T00:00:00Z")
	if r.From.Format(dateLayout) != "2026-09-18" {
		t.Errorf("from = %s", r.From.Format(dateLayout))
	}
}

func TestRangeValidation(t *testing.T) {
	ok := []string{"from=2026-09-01&to=2026-09-01", "from=2025-09-25&to=2026-09-25&source=all", "source=simulator"}
	for _, q := range ok {
		if _, err := rangeOf(t, q, "2026-10-08T00:00:00Z"); err != nil {
			t.Errorf("%s: %v", q, err)
		}
	}
	bad := map[string]string{
		"from=2026-09-02&to=2026-09-01":           "From is after to",
		"from=2025-09-24&to=2026-09-25":           "The range is longer than 366 days",
		"from=2026-9-1":                           "Invalid from: expected a date like 2026-09-24",
		"to=yesterday":                            "Invalid to: expected a date like 2026-09-24",
		"source=solar":                            "Invalid source: solar",
		"from=2026-09-01T00:00:00Z&to=2026-09-02": "Invalid from",
	}
	for q, want := range bad {
		_, err := rangeOf(t, q, "2026-10-08T00:00:00Z")
		if err == nil || !strings.Contains(httpx.SentenceCase(err.Error()), want) {
			t.Errorf("%s: err = %v, want %q", q, err, want)
		}
	}
}
