package httpx

import (
	"fmt"
	"net/http"
	"net/url"
	"strconv"
	"strings"

	"github.com/google/uuid"
)

// APIPrefix is where every route lives, as the Rust router nested them.
const APIPrefix = "/api/v1"

// Query reads query parameters with the rules of axum's Query extractor
// (serde_urlencoded): an absent key is "not given", a present one must parse, and the
// first failure becomes a 400 "Failed to deserialize query string: ...".
//
//	q := httpx.NewQuery(r)
//	limit := q.Int64("limit")       // *int64, nil when absent
//	needle := q.String("q")         // *string, non-nil even when empty
//	if err := q.Err(); err != nil { return err }
type Query struct {
	values url.Values
	err    error
}

// NewQuery parses r's query string.
func NewQuery(r *http.Request) *Query {
	return &Query{values: r.URL.Query()}
}

func (q *Query) fail(format string, args ...any) {
	if q.err == nil {
		q.err = rejection(http.StatusBadRequest, "Failed to deserialize query string: "+fmt.Sprintf(format, args...))
	}
}

func (q *Query) lookup(key string) (string, bool) {
	vs, ok := q.values[key]
	if !ok || len(vs) == 0 {
		return "", false
	}
	return vs[0], true
}

// Err returns the first parse failure, or nil.
func (q *Query) Err() error { return q.err }

// String is an optional string: nil when absent, the raw value (possibly "") when
// present. Pair with Filter to treat blank as absent.
func (q *Query) String(key string) *string {
	v, ok := q.lookup(key)
	if !ok {
		return nil
	}
	return &v
}

// RequiredString is a required string; absence is a 400.
func (q *Query) RequiredString(key string) string {
	v, ok := q.lookup(key)
	if !ok {
		q.fail("missing field `%s`", key)
	}
	return v
}

// Int64 is an optional integer; present but unparseable (including empty) is a 400.
func (q *Query) Int64(key string) *int64 {
	v, ok := q.lookup(key)
	if !ok {
		return nil
	}
	n, err := strconv.ParseInt(v, 10, 64)
	if err != nil {
		q.fail("%s: invalid digit found in string", key)
		return nil
	}
	return &n
}

// Float64 is an optional float; present but unparseable is a 400.
func (q *Query) Float64(key string) *float64 {
	v, ok := q.lookup(key)
	if !ok {
		return nil
	}
	f, err := strconv.ParseFloat(v, 64)
	if err != nil {
		q.fail("%s: invalid float literal", key)
		return nil
	}
	return &f
}

// Bool is an optional boolean: "true" or "false" only, as serde reads one.
func (q *Query) Bool(key string) *bool {
	v, ok := q.lookup(key)
	if !ok {
		return nil
	}
	switch v {
	case "true":
		b := true
		return &b
	case "false":
		b := false
		return &b
	}
	q.fail("%s: provided string was not `true` or `false`", key)
	return nil
}

// Filter trims an optional filter and treats blank as absent.
func Filter(v *string) *string {
	if v == nil {
		return nil
	}
	t := strings.TrimSpace(*v)
	if t == "" {
		return nil
	}
	return &t
}

// PathUUID reads a {name} path value as a uuid; an unparseable one is a 400, as
// axum's Path<Uuid> rejected it. Accepts the same forms (hyphenated, simple, braced,
// urn) and returns the canonical lowercase hyphenated form via String().
func PathUUID(r *http.Request, name string) (uuid.UUID, error) {
	raw := r.PathValue(name)
	id, err := uuid.Parse(raw)
	if err != nil {
		return uuid.UUID{}, rejection(http.StatusBadRequest, "Invalid URL: UUID parsing failed: "+err.Error())
	}
	return id, nil
}

// PathInt64 reads a {name} path value as an integer id; an unparseable one is a 400.
func PathInt64(r *http.Request, name string) (int64, error) {
	raw := r.PathValue(name)
	n, err := strconv.ParseInt(raw, 10, 64)
	if err != nil {
		return 0, rejection(http.StatusBadRequest, fmt.Sprintf("Invalid URL: Cannot parse `%s` to a `i64`", raw))
	}
	return n, nil
}

// Page is a window over a filtered result set: {rows, total, limit, offset}. Total
// counts every row matching the filters, not just this window.
type Page[T any] struct {
	Rows   []T   `json:"rows"`
	Total  int64 `json:"total"`
	Limit  int64 `json:"limit"`
	Offset int64 `json:"offset"`
}

// NewPage builds a page; a nil rows slice is sent as [] rather than null.
func NewPage[T any](rows []T, total, limit, offset int64) Page[T] {
	if rows == nil {
		rows = []T{}
	}
	return Page[T]{Rows: rows, Total: total, Limit: limit, Offset: offset}
}

// ResolvePaging clamps the window so a caller cannot ask for an unbounded or negative
// page: limit defaults to defLimit and is clamped to [1, maxLimit]; offset defaults to
// 0 and is floored at 0.
func ResolvePaging(limit, offset *int64, defLimit, maxLimit int64) (int64, int64) {
	l := defLimit
	if limit != nil {
		l = *limit
	}
	l = min(max(l, 1), maxLimit)
	o := int64(0)
	if offset != nil {
		o = max(*offset, 0)
	}
	return l, o
}
