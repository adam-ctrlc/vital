package audit

import (
	"context"
	"database/sql"
	"encoding/json"
	"fmt"
	"net/http"
	"strings"

	"github.com/adam-ctrlc/vital/api/internal/auth"
	"github.com/adam-ctrlc/vital/api/internal/db"
	"github.com/adam-ctrlc/vital/api/internal/httpx"
	"github.com/adam-ctrlc/vital/api/internal/wire"
)

// Paging bounds for GET /audit.
const (
	defaultLimit int64 = 50
	maxLimit     int64 = 200
)

// Event is one row of the log as the app sees it.
type Event struct {
	ID        int64           `json:"id"`
	At        wire.Time       `json:"at"`
	ActorID   *string         `json:"actorId"`
	ActorName *string         `json:"actorName"`
	Action    string          `json:"action"`
	Target    *string         `json:"target"`
	Detail    json.RawMessage `json:"detail"`
}

// filterSQL: ?1 an exact action, or ?2 a LIKE-escaped prefix; both null lists everything.
const filterSQL = ` from audit_events
 where (?1 is null or action = ?1)
   and (?2 is null or action like ?2 || '%' escape '\')`

// Store reads the log.
type Store struct {
	db *sql.DB
}

// NewStore returns a store over conn.
func NewStore(conn *sql.DB) *Store { return &Store{db: conn} }

// List returns a page of events, newest first. An action ending in "." matches every
// action under that prefix ("user." is every account change).
func (s *Store) List(ctx context.Context, action *string, limit, offset int64) (httpx.Page[Event], error) {
	var exact, prefix any
	if action != nil {
		if strings.HasSuffix(*action, ".") {
			prefix = db.EscapeLike(*action)
		} else {
			exact = *action
		}
	}

	var total int64
	if err := s.db.QueryRowContext(ctx, `select count(*)`+filterSQL, exact, prefix).Scan(&total); err != nil {
		return httpx.Page[Event]{}, fmt.Errorf("audit: count: %w", err)
	}

	rows, err := s.db.QueryContext(ctx, `select id, at, actor_id, actor_name, action, target, detail`+filterSQL+`
 order by at desc, id desc limit ?3 offset ?4`, exact, prefix, limit, offset)
	if err != nil {
		return httpx.Page[Event]{}, fmt.Errorf("audit: list: %w", err)
	}
	defer rows.Close()

	var events []Event
	for rows.Next() {
		var (
			e                               Event
			at                              string
			actorID, actorName, target, det sql.NullString
		)
		if err := rows.Scan(&e.ID, &at, &actorID, &actorName, &e.Action, &target, &det); err != nil {
			return httpx.Page[Event]{}, fmt.Errorf("audit: list: %w", err)
		}
		t, err := wire.ParseTime(at)
		if err != nil {
			return httpx.Page[Event]{}, httpx.Upstream("%v", err)
		}
		e.At = wire.Time{Time: t}
		e.ActorID, e.ActorName, e.Target = ptr(actorID), ptr(actorName), ptr(target)
		if det.Valid {
			e.Detail = json.RawMessage(det.String)
			if !json.Valid(e.Detail) {
				// Never written by this package, but a hand edit must not break the page.
				quoted, _ := json.Marshal(det.String)
				e.Detail = quoted
			}
		}
		events = append(events, e)
	}
	if err := rows.Err(); err != nil {
		return httpx.Page[Event]{}, fmt.Errorf("audit: list: %w", err)
	}
	return httpx.NewPage(events, total, limit, offset), nil
}

func ptr(s sql.NullString) *string {
	if !s.Valid {
		return nil
	}
	return &s.String
}

// Handler serves GET /api/v1/audit (admin).
type Handler struct {
	store *Store
	guard *auth.Guard
}

// NewHandler returns the audit route.
func NewHandler(store *Store, guard *auth.Guard) *Handler {
	return &Handler{store: store, guard: guard}
}

// Register mounts the route on mux.
func (h *Handler) Register(mux *http.ServeMux) {
	mux.Handle("GET "+httpx.APIPrefix+"/audit", h.guard.Admin(httpx.HandlerFunc(h.list)))
}

// list: GET /audit?limit=&offset=&action=
func (h *Handler) list(w http.ResponseWriter, r *http.Request) error {
	q := httpx.NewQuery(r)
	limit, offset := q.Int64("limit"), q.Int64("offset")
	action := httpx.Filter(q.String("action"))
	if err := q.Err(); err != nil {
		return err
	}
	l, o := httpx.ResolvePaging(limit, offset, defaultLimit, maxLimit)
	page, err := h.store.List(r.Context(), action, l, o)
	if err != nil {
		return err
	}
	httpx.WriteJSON(w, http.StatusOK, page)
	return nil
}
