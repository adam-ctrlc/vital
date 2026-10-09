package users

import (
	"net/http"
	"strings"

	"github.com/adam-ctrlc/vital/api/internal/audit"
	"github.com/adam-ctrlc/vital/api/internal/auth"
	"github.com/adam-ctrlc/vital/api/internal/db"
	"github.com/adam-ctrlc/vital/api/internal/httpx"
)

// Handler serves /api/v1/users. Every route is admin only.
type Handler struct {
	store *Store
	guard *auth.Guard
	audit *audit.Log
}

// NewHandler returns the users routes. Changes are recorded in log (nil records nothing).
func NewHandler(store *Store, guard *auth.Guard, log *audit.Log) *Handler {
	return &Handler{store: store, guard: guard, audit: log}
}

// Register mounts the routes on mux.
func (h *Handler) Register(mux *http.ServeMux) {
	const p = httpx.APIPrefix + "/users"
	admin := func(f httpx.HandlerFunc) http.Handler { return h.guard.Admin(f) }

	mux.Handle("GET "+p, admin(h.list))
	mux.Handle("POST "+p, admin(h.create))
	mux.Handle("GET "+p+"/username-suggestion", admin(h.usernameSuggestion))
	mux.Handle("PUT "+p+"/{id}", admin(h.update))
	mux.Handle("DELETE "+p+"/{id}", admin(h.remove))
	mux.Handle("POST "+p+"/{id}/approve", admin(h.approve))
}

// list: GET /users?q=&role=admin|user&status=pending|active
func (h *Handler) list(w http.ResponseWriter, r *http.Request) error {
	q := httpx.NewQuery(r)
	needle, role, status := httpx.Filter(q.String("q")), httpx.Filter(q.String("role")), httpx.Filter(q.String("status"))
	if err := q.Err(); err != nil {
		return err
	}

	if role != nil && *role != "admin" && *role != "user" {
		return httpx.BadRequest("invalid role: %s", *role)
	}
	if status != nil && *status != StatusPending && *status != StatusActive {
		return httpx.BadRequest("invalid status: %s", *status)
	}
	if needle != nil {
		escaped := db.EscapeLike(*needle)
		needle = &escaped
	}

	list, err := h.store.List(r.Context(), ListFilter{Role: role, Query: needle, Status: status})
	if err != nil {
		return err
	}
	httpx.WriteJSON(w, http.StatusOK, list)
	return nil
}

// usernameSuggestion backs the "Generate" button on the add-account form:
// GET /users/username-suggestion?firstName=&lastName= -> {"username": ...}
func (h *Handler) usernameSuggestion(w http.ResponseWriter, r *http.Request) error {
	q := httpx.NewQuery(r)
	first, last := q.RequiredString("firstName"), q.RequiredString("lastName")
	if err := q.Err(); err != nil {
		return err
	}

	name, err := h.store.SuggestUsername(r.Context(), first, last)
	if err != nil {
		return err
	}
	httpx.WriteJSON(w, http.StatusOK, map[string]string{"username": name})
	return nil
}

// create: POST /users -> 201, no body.
func (h *Handler) create(w http.ResponseWriter, r *http.Request) error {
	var in CreateInput
	if err := httpx.DecodeJSON(r, &in); err != nil {
		return err
	}

	if len(in.Password) < 8 {
		return httpx.BadRequest("password must be at least 8 characters")
	}
	// Only checked when given: blank means the account has no email.
	email := CleanEmail(in.Email)
	if email != nil && !strings.Contains(*email, "@") {
		return httpx.BadRequest("invalid email")
	}
	if strings.TrimSpace(in.FirstName) == "" {
		return httpx.BadRequest("first name is required")
	}
	if strings.TrimSpace(in.LastName) == "" {
		return httpx.BadRequest("last name is required")
	}

	ctx := r.Context()
	if taken, err := h.store.EmailTaken(ctx, email); err != nil {
		return err
	} else if taken {
		return httpx.BadRequest("email already registered")
	}
	// Only a username the admin typed is checked; a generated one is always free.
	if in.Username != nil {
		if name := CleanUsername(*in.Username); name != "" {
			if taken, err := h.store.UsernameTaken(ctx, name); err != nil {
				return err
			} else if taken {
				return httpx.BadRequest("username already taken")
			}
		}
	}

	username, err := h.store.Create(ctx, in, StatusActive)
	if err != nil {
		return err
	}
	admin, _ := auth.IdentityFrom(ctx)
	h.audit.Record(ctx, admin.ID, audit.UserCreate,
		FullName(trim(in.FirstName), CleanOptional(in.MiddleName), trim(in.LastName)),
		map[string]any{"username": username, "role": string(in.Role), "email": CleanEmail(in.Email)})
	httpx.NoContent(w, http.StatusCreated)
	return nil
}

// approve: POST /users/{id}/approve -> the account.
func (h *Handler) approve(w http.ResponseWriter, r *http.Request) error {
	id, err := httpx.PathUUID(r, "id")
	if err != nil {
		return err
	}
	u, activated, err := h.store.Approve(r.Context(), id)
	if err != nil {
		return err
	}
	if activated {
		admin, _ := auth.IdentityFrom(r.Context())
		h.audit.Record(r.Context(), admin.ID, audit.UserApprove, u.FullName, map[string]any{"username": u.Username})
	}
	httpx.WriteJSON(w, http.StatusOK, u)
	return nil
}

// update: PUT /users/{id} -> the account.
func (h *Handler) update(w http.ResponseWriter, r *http.Request) error {
	admin, _ := auth.IdentityFrom(r.Context())
	id, err := httpx.PathUUID(r, "id")
	if err != nil {
		return err
	}
	var in UpdateInput
	if err := httpx.DecodeJSON(r, &in); err != nil {
		return err
	}

	// Blank clears it, so only a non-blank email is checked.
	if e := CleanOptional(in.Email); e != nil && !strings.Contains(*e, "@") {
		return httpx.BadRequest("invalid email")
	}
	if strings.TrimSpace(in.FirstName) == "" {
		return httpx.BadRequest("first name is required")
	}
	if strings.TrimSpace(in.LastName) == "" {
		return httpx.BadRequest("last name is required")
	}
	if in.Password != nil && *in.Password != "" && len(*in.Password) < 8 {
		return httpx.BadRequest("password must be at least 8 characters")
	}

	// NotFound before the role guard, so a missing id never reads as a role error.
	before, err := h.store.Get(r.Context(), id)
	if err != nil {
		return err
	}
	if admin.ID == id && string(in.Role) != before.Role {
		return httpx.BadRequest("you cannot change your own role")
	}

	u, err := h.store.Update(r.Context(), id, in)
	if err != nil {
		return err
	}

	changes := audit.Changes{}
	changes.Add("email", before.Email, u.Email)
	changes.Add("username", before.Username, u.Username)
	changes.Add("role", before.Role, u.Role)
	changes.Add("firstName", before.FirstName, u.FirstName)
	changes.Add("middleName", before.MiddleName, u.MiddleName)
	changes.Add("lastName", before.LastName, u.LastName)
	if in.Password != nil && *in.Password != "" {
		// Never the hash, or anything derived from it.
		changes["password"] = audit.Change{From: nil, To: "changed"}
	}
	if len(changes) > 0 {
		h.audit.Record(r.Context(), admin.ID, audit.UserUpdate, u.FullName, changes)
	}
	httpx.WriteJSON(w, http.StatusOK, u)
	return nil
}

// remove: DELETE /users/{id} -> 204.
func (h *Handler) remove(w http.ResponseWriter, r *http.Request) error {
	admin, _ := auth.IdentityFrom(r.Context())
	id, err := httpx.PathUUID(r, "id")
	if err != nil {
		return err
	}
	if admin.ID == id {
		return httpx.BadRequest("you cannot delete your own account")
	}

	target, err := h.store.Get(r.Context(), id)
	if err != nil {
		return err
	}
	// Admins cannot remove each other: demoting first makes losing admin access a
	// deliberate two-step act rather than one tap.
	if target.Role == string(auth.Admin) {
		return httpx.BadRequest("an admin cannot be deleted. Change the role to user first")
	}

	removed, err := h.store.Delete(r.Context(), id)
	if err != nil {
		return err
	}
	if !removed {
		return httpx.ErrNotFound
	}
	h.audit.Record(r.Context(), admin.ID, audit.UserDelete, target.FullName,
		map[string]any{"username": target.Username, "role": target.Role})
	httpx.NoContent(w, http.StatusNoContent)
	return nil
}
