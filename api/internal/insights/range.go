// Package insights is the analysis behind the Insights and Reports screens:
// GET /api/v1/insights (energy and cost, the load heatmap, power quality, insulation
// aging and alert response) and GET /api/v1/readings/export (the readings as CSV).
//
// Days and hours are Manila's (UTC+8, no daylight saving), because that is where the
// transformer is and when its peaks happen; the stored instants stay UTC.
package insights

import (
	"time"

	"github.com/adam-ctrlc/vital/api/internal/httpx"
)

// manila is Philippine time, a fixed offset: the country has no daylight saving.
var manila = time.FixedZone("PHT", 8*3600)

const (
	dateLayout = "2006-01-02"
	// defaultDays is the range when none is given: the last week, today included.
	defaultDays = 7
	maxDays     = 366
)

// Range is a span of whole Manila days, both ends included, over one feed or both.
type Range struct {
	From, To time.Time // Manila midnight of the first and the last day
	// Source is "hardware", "simulator" or "all".
	Source string
}

// Start is the first instant in the range.
func (r Range) Start() time.Time { return r.From }

// End is the first instant after the range.
func (r Range) End() time.Time { return r.To.AddDate(0, 0, 1) }

// Days is how many calendar days the range spans.
func (r Range) Days() int { return int(r.End().Sub(r.Start()).Hours()/24 + 0.5) }

// sourceArg is the bind for "(?3 is null or source = ?3)".
func (r Range) sourceArg() any {
	if r.Source == "all" {
		return nil
	}
	return r.Source
}

// parseRange reads ?from=YYYY-MM-DD&to=YYYY-MM-DD&source=. Absent dates default to the
// last defaultDays Manila days ending today (now is the clock).
func parseRange(q *httpx.Query, now time.Time) (Range, error) {
	from, to := httpx.Filter(q.String("from")), httpx.Filter(q.String("to"))
	source := httpx.Filter(q.String("source"))
	if err := q.Err(); err != nil {
		return Range{}, err
	}

	today := midnight(now.In(manila))
	r := Range{To: today, Source: "hardware"}
	var err error
	if to != nil {
		if r.To, err = parseDate("to", *to); err != nil {
			return Range{}, err
		}
	}
	r.From = r.To.AddDate(0, 0, -(defaultDays - 1))
	if from != nil {
		if r.From, err = parseDate("from", *from); err != nil {
			return Range{}, err
		}
	}
	if source != nil {
		r.Source = *source
	}

	switch {
	case r.From.After(r.To):
		return Range{}, httpx.BadRequest("from is after to")
	case r.Days() > maxDays:
		return Range{}, httpx.BadRequest("the range is longer than %d days", maxDays)
	case r.Source != "hardware" && r.Source != "simulator" && r.Source != "all":
		return Range{}, httpx.BadRequest("invalid source: %s", r.Source)
	}
	return r, nil
}

func parseDate(name, raw string) (time.Time, error) {
	t, err := time.ParseInLocation(dateLayout, raw, manila)
	if err != nil {
		return time.Time{}, httpx.BadRequest("invalid %s: expected a date like 2026-09-24", name)
	}
	return t, nil
}

func midnight(t time.Time) time.Time {
	y, m, d := t.Date()
	return time.Date(y, m, d, 0, 0, 0, 0, manila)
}
