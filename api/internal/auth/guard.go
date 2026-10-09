package auth

import (
	"context"
	"crypto/subtle"
	"net/http"
	"strings"
	"time"

	"github.com/google/uuid"

	"github.com/adam-ctrlc/vital/api/internal/httpx"
)

// Identity is the caller a bearer token names.
type Identity struct {
	ID   uuid.UUID
	Role Role
}

type identityKey struct{}

// IdentityFrom returns the caller stored by User or Admin. ok is false only on a route
// that is not behind one of them, which is a wiring mistake.
func IdentityFrom(ctx context.Context) (Identity, bool) {
	id, ok := ctx.Value(identityKey{}).(Identity)
	return id, ok
}

// WithIdentity stores id in ctx. For tests and for middleware that authenticates by
// other means.
func WithIdentity(ctx context.Context, id Identity) context.Context {
	return context.WithValue(ctx, identityKey{}, id)
}

// Guard authenticates requests. Wrap a route's handler in one of its middlewares; the
// checks run before the handler reads its path or body, which is the order axum ran
// the Rust extractors in, so a bad token is a 401 before a bad body is a 4xx.
type Guard struct {
	secret    []byte
	deviceKey []byte
	now       func() time.Time
}

// NewGuard builds a guard from the JWT secret and the device key (empty rejects every
// device request).
func NewGuard(jwtSecret, deviceKey string) *Guard {
	g := &Guard{secret: []byte(jwtSecret), now: time.Now}
	if deviceKey != "" {
		g.deviceKey = []byte(deviceKey)
	}
	return g
}

// Secret is the HMAC key tokens are signed with.
func (g *Guard) Secret() []byte { return g.secret }

// Issue mints a token for an account.
func (g *Guard) Issue(id uuid.UUID, role Role) (string, error) {
	return EncodeToken(g.secret, id, role, g.now())
}

// Authenticate reads "Authorization: Bearer <token>" and verifies it.
func (g *Guard) Authenticate(r *http.Request) (Identity, error) {
	token, ok := strings.CutPrefix(r.Header.Get("Authorization"), "Bearer ")
	if !ok {
		return Identity{}, httpx.ErrUnauthorized
	}
	claims, err := DecodeToken(g.secret, strings.TrimSpace(token), g.now())
	if err != nil {
		return Identity{}, httpx.ErrUnauthorized
	}
	return Identity{ID: claims.Sub, Role: claims.Role}, nil
}

// User requires any valid token (401 otherwise) and stores the caller in the request
// context for IdentityFrom.
func (g *Guard) User(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		id, err := g.Authenticate(r)
		if err != nil {
			httpx.WriteError(w, r, err)
			return
		}
		next.ServeHTTP(w, r.WithContext(WithIdentity(r.Context(), id)))
	})
}

// Admin requires a valid token (401) whose role is admin (403 "Admin access required").
func (g *Guard) Admin(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		id, err := g.Authenticate(r)
		if err != nil {
			httpx.WriteError(w, r, err)
			return
		}
		if !id.Role.IsAdmin() {
			httpx.WriteError(w, r, httpx.ErrForbidden)
			return
		}
		next.ServeHTTP(w, r.WithContext(WithIdentity(r.Context(), id)))
	})
}

// Device requires the ESP32's x-device-key header to equal DEVICE_API_KEY. Fails
// closed: an unset key, a missing header or a mismatch is a 401, and the comparison
// is constant time so a wrong key leaks nothing through timing.
func (g *Guard) Device(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if !g.DeviceAuthorized(r) {
			httpx.WriteError(w, r, httpx.ErrUnauthorized)
			return
		}
		next.ServeHTTP(w, r)
	})
}

// DeviceAuthorized is the check behind Device, for a handler that needs it inline.
func (g *Guard) DeviceAuthorized(r *http.Request) bool {
	if len(g.deviceKey) == 0 {
		return false
	}
	provided, ok := r.Header["X-Device-Key"]
	if !ok || len(provided) == 0 {
		return false
	}
	return subtle.ConstantTimeCompare(g.deviceKey, []byte(provided[0])) == 1
}
