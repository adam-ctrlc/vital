package notifications

import (
	"net/http"

	"github.com/adam-ctrlc/vital/api/internal/auth"
	"github.com/adam-ctrlc/vital/api/internal/httpx"
)

// Handler serves /api/v1/notifications.
type Handler struct {
	store *Store
	guard *auth.Guard
}

// NewHandler returns the notification routes.
func NewHandler(store *Store, guard *auth.Guard) *Handler {
	return &Handler{store: store, guard: guard}
}

// Register mounts the routes on mux. Any signed-in role may register: utility
// personnel are the ones expected to respond to an overload.
func (h *Handler) Register(mux *http.ServeMux) {
	const p = httpx.APIPrefix + "/notifications"
	mux.Handle("POST "+p+"/register", h.guard.User(httpx.HandlerFunc(h.register)))
	mux.Handle("POST "+p+"/unregister", h.guard.User(httpx.HandlerFunc(h.unregister)))
}

// register: POST /notifications/register {token, platform?, channelId?} -> 204.
func (h *Handler) register(w http.ResponseWriter, r *http.Request) error {
	var body RegisterToken
	if err := httpx.DecodeJSON(r, &body); err != nil {
		return err
	}
	reg, err := body.Registration()
	if err != nil {
		return err
	}
	caller, ok := auth.IdentityFrom(r.Context())
	if !ok {
		return httpx.ErrUnauthorized
	}
	if err := h.store.Register(r.Context(), caller.ID, reg); err != nil {
		return err
	}
	httpx.NoContent(w, http.StatusNoContent)
	return nil
}

// unregister: POST /notifications/unregister {token} -> 204, whether or not anything
// was removed.
func (h *Handler) unregister(w http.ResponseWriter, r *http.Request) error {
	var body RegisterToken
	if err := httpx.DecodeJSON(r, &body); err != nil {
		return err
	}
	caller, ok := auth.IdentityFrom(r.Context())
	if !ok {
		return httpx.ErrUnauthorized
	}
	if err := h.store.Unregister(r.Context(), caller.ID, body.UnregisterToken()); err != nil {
		return err
	}
	httpx.NoContent(w, http.StatusNoContent)
	return nil
}
