package alerts

import (
	"net/http"

	"github.com/adam-ctrlc/vital/api/internal/db"
	"github.com/adam-ctrlc/vital/api/internal/httpx"
)

// Paging defaults for the alert list.
const (
	DefaultLimit int64 = 20
	MaxLimit     int64 = 200
)

// ListQuery is the resolved filter of GET /alerts.
type ListQuery struct {
	// Active limits the list to unacknowledged alerts.
	Active bool
	// Kind is an exact kind, or "" for any.
	Kind Kind
	// Search is the free-text needle over message and kind, already escaped for
	// like, or "" for no search.
	Search string
	// Limit and Offset are already clamped.
	Limit  int64
	Offset int64
}

// ParseListQuery reads ?active=&q=&kind=&limit=&offset= as the Rust ListQuery did.
//
// A malformed value (active not exactly true/false, a non-integer or empty limit or
// offset) is axum's plain-text 400. kind and q are trimmed and blank means absent, so
// ?q= behaves like no q. A kind naming neither kind is a 400
// "Invalid alert kind: <kind>".
func ParseListQuery(r *http.Request) (ListQuery, error) {
	q := httpx.NewQuery(r)
	active := q.Bool("active")
	search := q.String("q")
	kind := q.String("kind")
	limit := q.Int64("limit")
	offset := q.Int64("offset")
	if err := q.Err(); err != nil {
		return ListQuery{}, err
	}
	return NewListQuery(active, httpx.Filter(kind), httpx.Filter(search), limit, offset)
}

// NewListQuery resolves already-parsed filters: kind and search already trimmed (nil
// when blank), paging still raw.
func NewListQuery(active *bool, kind, search *string, limit, offset *int64) (ListQuery, error) {
	var lq ListQuery
	if active != nil {
		lq.Active = *active
	}
	lq.Limit, lq.Offset = httpx.ResolvePaging(limit, offset, DefaultLimit, MaxLimit)

	if kind != nil {
		if !Kind(*kind).Valid() {
			return ListQuery{}, httpx.BadRequest("invalid alert kind: %s", *kind)
		}
		lq.Kind = Kind(*kind)
	}
	if search != nil {
		lq.Search = db.EscapeLike(*search)
	}
	return lq, nil
}

// countArgs binds SQLCountAlerts.
func (q ListQuery) countArgs() []any {
	return []any{boolInt(q.Active), nullIfEmpty(string(q.Kind)), nullIfEmpty(q.Search)}
}

// rowArgs binds SQLListAlerts.
func (q ListQuery) rowArgs() []any {
	return append(q.countArgs(), q.Limit, q.Offset)
}

func boolInt(b bool) int64 {
	if b {
		return 1
	}
	return 0
}

func nullIfEmpty(s string) any {
	if s == "" {
		return nil
	}
	return s
}
