package account

import (
	"database/sql"
	"log/slog"
	"net/http"
	"strings"
	"time"

	"github.com/adam-ctrlc/vital/api/internal/audit"
	"github.com/adam-ctrlc/vital/api/internal/auth"
	"github.com/adam-ctrlc/vital/api/internal/httpx"
	"github.com/adam-ctrlc/vital/api/internal/users"
)

// Rate limits for the two public routes, per caller IP.
const (
	// Ten attempts up front, then one every ten seconds: generous for a mistyped
	// password on a phone keyboard, tight enough that sustained guessing runs at six
	// tries a minute.
	LoginBurst  = 10
	LoginPeriod = 10 * time.Second

	// Sign-ups are rarer and each lands in an admin's queue: three up front, then one
	// a minute.
	RegisterBurst  = 3
	RegisterPeriod = 60 * time.Second
)

// Handler serves /api/v1/auth.
type Handler struct {
	store    store
	users    *users.Store
	guard    *auth.Guard
	login    *httpx.RateLimit
	register *httpx.RateLimit
	audit    *audit.Log
}

// NewHandler returns the /auth routes. Profile and password changes are recorded in
// log (nil records nothing).
func NewHandler(conn *sql.DB, userStore *users.Store, guard *auth.Guard, log *audit.Log) *Handler {
	return &Handler{
		store:    store{db: conn},
		users:    userStore,
		guard:    guard,
		audit:    log,
		login:    httpx.NewRateLimit("login", LoginBurst, LoginPeriod),
		register: httpx.NewRateLimit("register", RegisterBurst, RegisterPeriod),
	}
}

// Register mounts the routes on mux. The limiters wrap only their own route: the
// ESP32 posts every ten seconds and the dashboard polls every second, so a router-wide
// limiter would throttle the product rather than the attacker.
func (h *Handler) Register(mux *http.ServeMux) {
	const p = httpx.APIPrefix + "/auth"
	mux.Handle("POST "+p+"/login", h.login.Middleware(httpx.HandlerFunc(h.signIn)))
	mux.Handle("POST "+p+"/register", h.register.Middleware(httpx.HandlerFunc(h.signUp)))
	mux.Handle("GET "+p+"/me", h.guard.User(httpx.HandlerFunc(h.me)))
	mux.Handle("PUT "+p+"/me", h.guard.User(httpx.HandlerFunc(h.updateMe)))
	mux.Handle("PUT "+p+"/password", h.guard.User(httpx.HandlerFunc(h.changePassword)))
}

type loginRequest struct {
	// Identifier is an email or a username. "email" is still read for older clients.
	Identifier *string `json:"identifier"`
	Email      *string `json:"email"`
	Password   string  `json:"password" required:"true"`
	// Role is the portal the caller chose. Enforced here, not only in the app.
	Role *auth.Role `json:"role"`
}

type loginResponse struct {
	Token string  `json:"token"`
	User  Profile `json:"user"`
}

// signIn: POST /auth/login -> {token, user}.
func (h *Handler) signIn(w http.ResponseWriter, r *http.Request) error {
	var body loginRequest
	if err := httpx.DecodeJSON(r, &body); err != nil {
		return err
	}
	// serde's alias: either key, not both, and one of them is required.
	raw := body.Identifier
	switch {
	case body.Identifier != nil && body.Email != nil:
		return &httpx.Error{Status: http.StatusUnprocessableEntity, Plain: true,
			Message: "Failed to deserialize the JSON body into the target type: duplicate field `identifier`"}
	case body.Identifier == nil && body.Email == nil:
		return &httpx.Error{Status: http.StatusUnprocessableEntity, Plain: true,
			Message: "Failed to deserialize the JSON body into the target type: missing field `identifier`"}
	case raw == nil:
		raw = body.Email
	}
	identifier := strings.ToLower(strings.TrimSpace(*raw))
	ctx := r.Context()

	found, ok, err := h.store.byIdentifier(ctx, identifier)
	if err != nil {
		return err
	}
	if !ok {
		// Spend the same argon2 work as a real account so timing does not reveal
		// which accounts exist.
		auth.VerifyDummy(body.Password)
		slog.WarnContext(ctx, "login failed", "identifier", identifier, "reason", "no such account")
		return httpx.ErrInvalidCredentials
	}
	if !auth.VerifyPassword(body.Password, found.passwordHash) {
		slog.WarnContext(ctx, "login failed", "identifier", identifier, "reason", "wrong password")
		return httpx.ErrInvalidCredentials
	}

	// After the password, so only the account's owner learns it exists and waits.
	if found.status == users.StatusPending {
		slog.InfoContext(ctx, "login refused: awaiting approval", "identifier", identifier)
		return httpx.ErrPendingApproval
	}

	role, err := found.parsedRole()
	if err != nil {
		return err
	}
	// After the password too, so a wrong portal on a bad password still reads
	// "invalid credentials" and reveals neither the account nor its role.
	if body.Role != nil && *body.Role != role {
		slog.WarnContext(ctx, "login failed", "identifier", identifier, "reason", "wrong portal")
		return &httpx.Error{Status: http.StatusUnauthorized, Message: role.PortalHint()}
	}

	token, err := h.guard.Issue(found.id, role)
	if err != nil {
		return httpx.ErrToken.With(err)
	}
	httpx.WriteJSON(w, http.StatusOK, loginResponse{Token: token, User: found.profile(role)})
	return nil
}

type registerRequest struct {
	FirstName  string  `json:"firstName" required:"true"`
	MiddleName *string `json:"middleName"`
	LastName   string  `json:"lastName" required:"true"`
	// Username is optional: generated from the name when blank.
	Username *string `json:"username"`
	Email    *string `json:"email"`
	Password string  `json:"password" required:"true"`
}

// signUp: POST /auth/register -> 201 {"username": ...}. Always a standard user, and
// pending until an admin approves it, so registering grants nothing on its own.
func (h *Handler) signUp(w http.ResponseWriter, r *http.Request) error {
	var body registerRequest
	if err := httpx.DecodeJSON(r, &body); err != nil {
		return err
	}
	if strings.TrimSpace(body.FirstName) == "" {
		return httpx.BadRequest("first name is required")
	}
	if strings.TrimSpace(body.LastName) == "" {
		return httpx.BadRequest("last name is required")
	}
	if len(body.Password) < 8 {
		return httpx.BadRequest("password must be at least 8 characters")
	}
	email := users.CleanEmail(body.Email)
	if email != nil && !strings.Contains(*email, "@") {
		return httpx.BadRequest("invalid email")
	}

	ctx := r.Context()
	if taken, err := h.users.EmailTaken(ctx, email); err != nil {
		return err
	} else if taken {
		return httpx.BadRequest("email already registered")
	}

	username := ""
	if body.Username != nil {
		username = users.CleanUsername(*body.Username)
	}
	if username != "" {
		if taken, err := h.users.UsernameTaken(ctx, username); err != nil {
			return err
		} else if taken {
			return httpx.BadRequest("username already taken")
		}
	} else {
		var err error
		if username, err = h.users.SuggestUsername(ctx, body.FirstName, body.LastName); err != nil {
			return err
		}
	}

	_, err := h.users.Create(ctx, users.CreateInput{
		Email: email, Password: body.Password, Role: auth.User,
		FirstName: body.FirstName, MiddleName: body.MiddleName, LastName: body.LastName,
		Username: &username,
	}, users.StatusPending)
	if err != nil {
		return err
	}

	slog.InfoContext(ctx, "account registered, awaiting approval", "username", username)
	httpx.WriteJSON(w, http.StatusCreated, map[string]string{"username": username})
	return nil
}

// me: GET /auth/me -> Profile.
func (h *Handler) me(w http.ResponseWriter, r *http.Request) error {
	caller, _ := auth.IdentityFrom(r.Context())
	found, err := h.store.byID(r.Context(), caller.ID)
	if err != nil {
		return err
	}
	role, err := found.parsedRole()
	if err != nil {
		return err
	}
	httpx.WriteJSON(w, http.StatusOK, found.profile(role))
	return nil
}

type updateProfileRequest struct {
	FirstName  string  `json:"firstName" required:"true"`
	MiddleName *string `json:"middleName"`
	LastName   string  `json:"lastName" required:"true"`
	Email      *string `json:"email"`
	Username   *string `json:"username"`
}

// updateMe: PUT /auth/me -> Profile. Names are always editable. Email and username
// are the login identity: a standard user may not change them, an admin may. The role
// is fixed here; an account raising its own role would defeat having roles.
func (h *Handler) updateMe(w http.ResponseWriter, r *http.Request) error {
	caller, _ := auth.IdentityFrom(r.Context())
	var body updateProfileRequest
	if err := httpx.DecodeJSON(r, &body); err != nil {
		return err
	}
	if strings.TrimSpace(body.FirstName) == "" {
		return httpx.BadRequest("First name is required")
	}
	if strings.TrimSpace(body.LastName) == "" {
		return httpx.BadRequest("Last name is required")
	}

	ctx := r.Context()
	current, err := h.store.byID(ctx, caller.ID)
	if err != nil {
		return err
	}

	isAdmin := caller.Role.IsAdmin()
	email, err := resolveEmail(isAdmin, body.Email, current.email)
	if err != nil {
		return err
	}
	username, err := resolveUsername(isAdmin, body.Username, current.username)
	if err != nil {
		return err
	}

	updated, err := h.store.updateProfile(ctx, caller.ID, strings.TrimSpace(body.FirstName),
		users.CleanOptional(body.MiddleName), strings.TrimSpace(body.LastName), email, username)
	if err != nil {
		return err
	}
	role, err := updated.parsedRole()
	if err != nil {
		return err
	}

	changes := audit.Changes{}
	changes.Add("firstName", current.firstName, updated.firstName)
	changes.Add("middleName", current.middleName, updated.middleName)
	changes.Add("lastName", current.lastName, updated.lastName)
	changes.Add("email", current.email, updated.email)
	changes.Add("username", current.username, updated.username)
	if len(changes) > 0 {
		profile := updated.profile(role)
		h.audit.Record(ctx, caller.ID, audit.AccountUpdate, profile.FullName, changes)
	}
	httpx.WriteJSON(w, http.StatusOK, updated.profile(role))
	return nil
}

// resolveEmail decides the email bind for a profile update; nil leaves it unchanged.
// Blank leaves it alone rather than clearing it, so an account without an email can
// save its profile. A non-admin may only resend their current value.
func resolveEmail(isAdmin bool, provided, current *string) (*string, error) {
	if provided == nil {
		return nil, nil
	}
	normalized := strings.ToLower(strings.TrimSpace(*provided))
	if normalized == "" {
		return nil, nil
	}
	switch {
	case !isAdmin && current != nil && normalized == *current:
		return nil, nil
	case !isAdmin:
		return nil, httpx.ErrForbidden
	case !strings.Contains(normalized, "@"):
		return nil, httpx.BadRequest("Invalid email")
	}
	return &normalized, nil
}

// resolveUsername decides the username bind for a profile update; nil leaves it
// unchanged. A non-admin may only resend their current value; an admin's must not
// clean to nothing.
func resolveUsername(isAdmin bool, provided *string, current string) (*string, error) {
	if provided == nil {
		return nil, nil
	}
	cleaned := users.CleanUsername(*provided)
	switch {
	case !isAdmin && cleaned == current:
		return nil, nil
	case !isAdmin:
		return nil, httpx.ErrForbidden
	case cleaned == "":
		return nil, httpx.BadRequest("Username is required")
	}
	return &cleaned, nil
}

type changePasswordRequest struct {
	CurrentPassword string `json:"currentPassword" required:"true"`
	NewPassword     string `json:"newPassword" required:"true"`
}

// changePassword: PUT /auth/password -> 204. The current password is required so a
// stolen token cannot lock the owner out.
func (h *Handler) changePassword(w http.ResponseWriter, r *http.Request) error {
	caller, _ := auth.IdentityFrom(r.Context())
	var body changePasswordRequest
	if err := httpx.DecodeJSON(r, &body); err != nil {
		return err
	}
	if len(body.NewPassword) < 8 {
		return httpx.BadRequest("New password must be at least 8 characters")
	}

	ctx := r.Context()
	found, err := h.store.byID(ctx, caller.ID)
	if err != nil {
		return err
	}
	if !auth.VerifyPassword(body.CurrentPassword, found.passwordHash) {
		return httpx.ErrInvalidCredentials
	}
	hash, err := auth.HashPassword(body.NewPassword)
	if err != nil {
		return httpx.ErrPasswordHash.With(err)
	}
	if err := h.store.setPassword(ctx, caller.ID, hash); err != nil {
		return err
	}
	h.audit.Record(ctx, caller.ID, audit.AccountPassword, users.FullName(found.firstName, found.middleName, found.lastName), nil)
	httpx.NoContent(w, http.StatusNoContent)
	return nil
}
