// Package users is account management for admins (/api/v1/users) and the account
// storage the /auth routes in package account share.
package users

import (
	"strings"
	"unicode"
	"unicode/utf8"

	"github.com/google/uuid"

	"github.com/adam-ctrlc/vital/api/internal/auth"
	"github.com/adam-ctrlc/vital/api/internal/wire"
)

// Account status: a self-registered account is pending until an admin approves it.
const (
	StatusPending = "pending"
	StatusActive  = "active"
)

// User is an account as the admin screens see it.
type User struct {
	ID uuid.UUID `json:"id"`
	// Email is nil for an account created without one; the username is the identity
	// the system relies on.
	Email      *string   `json:"email"`
	Username   string    `json:"username"`
	Role       string    `json:"role"`
	FirstName  string    `json:"firstName"`
	MiddleName *string   `json:"middleName"`
	LastName   string    `json:"lastName"`
	FullName   string    `json:"fullName"`
	Status     string    `json:"status"`
	CreatedAt  wire.Time `json:"createdAt"`
}

// CreateInput is the body of POST /users, and what registration creates.
type CreateInput struct {
	// Email is optional: blank or absent creates the account without one.
	Email      *string   `json:"email"`
	Password   string    `json:"password" required:"true"`
	Role       auth.Role `json:"role" required:"true"`
	FirstName  string    `json:"firstName" required:"true"`
	MiddleName *string   `json:"middleName"`
	LastName   string    `json:"lastName" required:"true"`
	// Username is optional: blank or absent generates one from the name.
	Username *string `json:"username"`
}

// UpdateInput is the body of PUT /users/{id}.
type UpdateInput struct {
	// Email: blank or absent clears it.
	Email      *string   `json:"email"`
	Role       auth.Role `json:"role" required:"true"`
	FirstName  string    `json:"firstName" required:"true"`
	MiddleName *string   `json:"middleName"`
	LastName   string    `json:"lastName" required:"true"`
	// Username: blank or absent keeps the existing one.
	Username *string `json:"username"`
	// Password: blank or absent keeps the existing hash.
	Password *string `json:"password"`
}

// CleanUsername lowercases and strips a username to ASCII letters and digits, so a
// value typed in the app and one generated from a name cannot disagree.
func CleanUsername(s string) string {
	var b strings.Builder
	for _, r := range s {
		if r < utf8.RuneSelf && (unicode.IsLetter(r) || unicode.IsDigit(r)) {
			b.WriteRune(unicode.ToLower(r))
		}
	}
	return b.String()
}

// FullName composes the display name: the trimmed parts that are not blank, joined by
// single spaces.
func FullName(first string, middle *string, last string) string {
	parts := make([]string, 0, 3)
	for _, p := range []string{first, deref(middle), last} {
		if p = strings.TrimSpace(p); p != "" {
			parts = append(parts, p)
		}
	}
	return strings.Join(parts, " ")
}

// CleanOptional trims an optional value and treats blank as absent.
func CleanOptional(s *string) *string {
	if s == nil {
		return nil
	}
	t := strings.TrimSpace(*s)
	if t == "" {
		return nil
	}
	return &t
}

// CleanEmail is CleanOptional, lowercased: emails are stored lowercase so one
// lowercased login needle matches either email or username.
func CleanEmail(s *string) *string {
	c := CleanOptional(s)
	if c == nil {
		return nil
	}
	l := strings.ToLower(*c)
	return &l
}

func deref(s *string) string {
	if s == nil {
		return ""
	}
	return *s
}

// usernameBase is the generation rule: the first initial and the surname, cleaned,
// or "user" when nothing survives cleaning.
func usernameBase(first, last string) string {
	initial := ""
	if r, size := utf8.DecodeRuneInString(strings.TrimSpace(first)); size > 0 {
		initial = string(r)
	}
	base := CleanUsername(initial + strings.TrimSpace(last))
	if base == "" {
		return "user"
	}
	return base
}
