// Package auth holds the authentication primitives: roles, the JWT the API issues,
// argon2 password hashes, and the middleware that guards routes by bearer token or by
// the device key. The /auth/* routes themselves live in package account, which can
// depend on users without a cycle.
package auth

import (
	"encoding/json"
	"fmt"
)

// Role is an account's role, "admin" or "user" on the wire, in the database and in
// the token.
type Role string

const (
	Admin Role = "admin"
	User  Role = "user"
)

// ParseRole validates a role string.
func ParseRole(s string) (Role, error) {
	switch Role(s) {
	case Admin, User:
		return Role(s), nil
	}
	return "", fmt.Errorf("invalid role: %s", s)
}

// IsAdmin reports whether r is the admin role.
func (r Role) IsAdmin() bool { return r == Admin }

// PortalHint is shown when someone signs in through the wrong portal. Lowercase so it
// composes; the JSON layer sentence-cases it.
func (r Role) PortalHint() string {
	if r == Admin {
		return "you're an admin. Choose Admin above, then sign in"
	}
	return "you're a standard user. Choose User above, then sign in"
}

// UnmarshalJSON refuses anything but the two roles, as serde's enum did; in a request
// body that is a 422.
func (r *Role) UnmarshalJSON(b []byte) error {
	var s string
	if err := json.Unmarshal(b, &s); err != nil {
		return fmt.Errorf("invalid type: %s, expected `admin` or `user`", b)
	}
	parsed, err := ParseRole(s)
	if err != nil {
		return fmt.Errorf("unknown variant `%s`, expected `admin` or `user`", s)
	}
	*r = parsed
	return nil
}
