package readings

import (
	"math"

	"github.com/adam-ctrlc/vital/api/internal/db"
	"github.com/adam-ctrlc/vital/api/internal/httpx"
)

// History paging bounds.
const (
	defaultHistoryLimit int64 = 20
	maxHistoryLimit     int64 = 500
)

// HistoryQuery is the reading log's query string, decoded but not yet validated.
// A nil field is an absent parameter.
// Read it with historyQueryFrom, which gives axum's plain-text 400 for a malformed
// number.
type HistoryQuery struct {
	Status *string // "normal" or "overload"
	Source *string // "hardware" or "simulator"
	Q      *string // free text over status, source, rounded VA and local timestamp
	From   *string // inclusive lower bound on recorded_at, RFC 3339
	To     *string // exclusive upper bound on recorded_at, RFC 3339
	MinVA  *float64
	MaxVA  *float64
	// MinTempC is a lower bound on temperature, in degrees Celsius.
	MinTempC *float64
	Sort     *string // "newest" (default), "oldest", "load" or "temperature"
	Limit    *int64
	Offset   *int64
}

// HistoryFilter is a validated HistoryQuery, ready to bind to historyCountSQL and
// HistoryFilter.SelectSQL.
type HistoryFilter struct {
	Status   *string
	Q        *string // LIKE-escaped
	Source   *string
	From     *string // in the stored shape
	To       *string // in the stored shape
	MinVA    *float64
	MaxVA    *float64
	MinTempC *float64
	Limit    int64
	Offset   int64
	order    string
}

// Resolve validates the query. Errors are 400s with the Rust API's messages, checked
// in its order.
func (q HistoryQuery) Resolve() (HistoryFilter, error) {
	limit, offset := httpx.ResolvePaging(q.Limit, q.Offset, defaultHistoryLimit, maxHistoryLimit)
	f := HistoryFilter{
		Status: httpx.Filter(q.Status),
		Source: httpx.Filter(q.Source),
		Limit:  limit,
		Offset: offset,
	}
	if needle := httpx.Filter(q.Q); needle != nil {
		escaped := db.EscapeLike(*needle)
		f.Q = &escaped
	}

	var err error
	if f.From, err = instant("from", q.From); err != nil {
		return HistoryFilter{}, err
	}
	if f.To, err = instant("to", q.To); err != nil {
		return HistoryFilter{}, err
	}
	if f.MinVA, err = bound("minVa", q.MinVA); err != nil {
		return HistoryFilter{}, err
	}
	if f.MaxVA, err = bound("maxVa", q.MaxVA); err != nil {
		return HistoryFilter{}, err
	}
	if f.MinTempC, err = bound("minTempC", q.MinTempC); err != nil {
		return HistoryFilter{}, err
	}
	if f.order, err = orderBy(httpx.Filter(q.Sort)); err != nil {
		return HistoryFilter{}, err
	}

	if f.MinVA != nil && f.MaxVA != nil && *f.MinVA > *f.MaxVA {
		return HistoryFilter{}, httpx.BadRequest("minVa is above maxVa")
	}
	// Both are in the stored shape, so text order is time order.
	if f.From != nil && f.To != nil && *f.From >= *f.To {
		return HistoryFilter{}, httpx.BadRequest("from is not before to")
	}
	if f.Status != nil {
		if _, err := ParseStatus(*f.Status); err != nil {
			return HistoryFilter{}, err
		}
	}
	if f.Source != nil && *f.Source != "hardware" && *f.Source != "simulator" {
		return HistoryFilter{}, httpx.BadRequest("invalid source: %s", *f.Source)
	}
	return f, nil
}

// FilterArgs are the binds for ?1..?8 of historyFilter, in order. Absent filters
// are untyped nil, which the driver sends as SQL NULL.
func (f HistoryFilter) FilterArgs() []any {
	return []any{
		nullable(f.Status), nullable(f.Q), nullable(f.Source),
		nullable(f.From), nullable(f.To),
		nullable(f.MinVA), nullable(f.MaxVA), nullable(f.MinTempC),
	}
}

// SelectArgs are FilterArgs followed by the limit (?9) and offset (?10).
func (f HistoryFilter) SelectArgs() []any {
	return append(f.FilterArgs(), f.Limit, f.Offset)
}

// SelectSQL is the page query. The ORDER BY comes only from orderBy's fixed list;
// it can never be built from the request.
func (f HistoryFilter) SelectSQL() string {
	order := f.order
	if order == "" {
		order = orderNewest
	}
	return historySelectPrefix + order + historySelectSuffix
}

// The ORDER BY clauses a sort key may select.
const (
	orderNewest      = "recorded_at desc"
	orderOldest      = "recorded_at asc"
	orderLoad        = "apparent_power_va is null, apparent_power_va desc, recorded_at desc"
	orderTemperature = "temperature_c is null, temperature_c desc, recorded_at desc"
)

// orderBy maps a sort key to its ORDER BY. A fixed list, because the clause cannot be
// a bound parameter. Ties fall back to newest first, and readings missing the sorted
// value go last.
func orderBy(sort *string) (string, error) {
	key := "newest"
	if sort != nil {
		key = *sort
	}
	switch key {
	case "newest":
		return orderNewest, nil
	case "oldest":
		return orderOldest, nil
	case "load":
		return orderLoad, nil
	case "temperature":
		return orderTemperature, nil
	default:
		return "", httpx.BadRequest("invalid sort: %s", key)
	}
}

// instant resolves an optional RFC 3339 parameter into the stored shape. Blank is absent.
func instant(name string, raw *string) (*string, error) {
	value := httpx.Filter(raw)
	if value == nil {
		return nil, nil
	}
	stored, err := storedInstant(*value)
	if err != nil {
		return nil, httpx.BadRequest("invalid %s: expected an RFC 3339 instant", name)
	}
	return &stored, nil
}

// bound refuses a numeric bound that is not finite (NaN and ±Inf parse as floats).
func bound(name string, value *float64) (*float64, error) {
	if value != nil && (math.IsNaN(*value) || math.IsInf(*value, 0)) {
		return nil, httpx.BadRequest("invalid %s", name)
	}
	return value, nil
}

// nullable turns a nil pointer into an untyped nil and a set one into its value.
func nullable[T any](p *T) any {
	if p == nil {
		return nil
	}
	return *p
}
