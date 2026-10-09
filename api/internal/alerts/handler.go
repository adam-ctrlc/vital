package alerts

import (
	"net/http"

	"github.com/adam-ctrlc/vital/api/internal/auth"
	"github.com/adam-ctrlc/vital/api/internal/httpx"
)

// Handler serves /api/v1/alerts.
type Handler struct {
	store *Store
	guard *auth.Guard
}

// NewHandler returns the alert routes.
func NewHandler(store *Store, guard *auth.Guard) *Handler {
	return &Handler{store: store, guard: guard}
}

// Register mounts the routes on mux. Both are open to any signed-in caller.
func (h *Handler) Register(mux *http.ServeMux) {
	const p = httpx.APIPrefix + "/alerts"
	mux.Handle("GET "+p, h.guard.User(httpx.HandlerFunc(h.list)))
	mux.Handle("POST "+p+"/{id}/ack", h.guard.User(httpx.HandlerFunc(h.acknowledge)))
}

// list: GET /alerts?active=&q=&kind=&limit=&offset= -> {rows, total, limit, offset},
// each row an alert with its reading's measurements.
func (h *Handler) list(w http.ResponseWriter, r *http.Request) error {
	q, err := ParseListQuery(r)
	if err != nil {
		return err
	}
	rows, total, err := h.store.List(r.Context(), q)
	if err != nil {
		return err
	}
	httpx.WriteJSON(w, http.StatusOK, httpx.NewPage(rows, total, q.Limit, q.Offset))
	return nil
}

// acknowledge: POST /alerts/{id}/ack -> the alert, with how long the responder took.
// A missing or already acknowledged alert is a 404.
func (h *Handler) acknowledge(w http.ResponseWriter, r *http.Request) error {
	id, err := httpx.PathInt64(r, "id")
	if err != nil {
		return err
	}
	caller, ok := auth.IdentityFrom(r.Context())
	if !ok {
		return httpx.ErrUnauthorized
	}
	a, ok, err := h.store.Acknowledge(r.Context(), id, caller.ID)
	if err != nil {
		return err
	}
	if !ok {
		return httpx.ErrNotFound
	}
	httpx.WriteJSON(w, http.StatusOK, a)
	return nil
}
