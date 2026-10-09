// Package account serves /api/v1/auth: sign-in, self-registration, and the caller's
// own profile and password. Separate from package auth (the primitives) so it can use
// package users without an import cycle.
package account

import (
	"context"
	"database/sql"
	"fmt"

	"github.com/google/uuid"

	"github.com/adam-ctrlc/vital/api/internal/auth"
	"github.com/adam-ctrlc/vital/api/internal/db"
	"github.com/adam-ctrlc/vital/api/internal/httpx"
	"github.com/adam-ctrlc/vital/api/internal/users"
)

// credentialColumns is what every account lookup selects, in scanCredentials' order.
const credentialColumns = "id, email, username, password_hash, role, first_name, middle_name, last_name, status"

// credentials is an account with its password hash, which never leaves this package.
type credentials struct {
	id           uuid.UUID
	email        *string
	username     string
	passwordHash string
	role         string
	firstName    string
	middleName   *string
	lastName     string
	status       string
}

// Profile is the account as its owner sees it: the user in a login response, and
// GET/PUT /auth/me.
type Profile struct {
	ID         uuid.UUID `json:"id"`
	Email      *string   `json:"email"`
	Username   string    `json:"username"`
	Role       auth.Role `json:"role"`
	FirstName  string    `json:"firstName"`
	MiddleName *string   `json:"middleName"`
	LastName   string    `json:"lastName"`
	FullName   string    `json:"fullName"`
}

func (c credentials) profile(role auth.Role) Profile {
	return Profile{
		ID: c.id, Email: c.email, Username: c.username, Role: role,
		FirstName: c.firstName, MiddleName: c.middleName, LastName: c.lastName,
		FullName: users.FullName(c.firstName, c.middleName, c.lastName),
	}
}

// parsedRole reads the stored role; anything else is the Rust API's 400.
func (c credentials) parsedRole() (auth.Role, error) {
	role, err := auth.ParseRole(c.role)
	if err != nil {
		return "", httpx.BadRequest("%v", err)
	}
	return role, nil
}

type store struct {
	db *sql.DB
}

func scanCredentials(row *sql.Row) (credentials, bool, error) {
	var (
		c             credentials
		id            string
		email, middle sql.NullString
	)
	err := row.Scan(&id, &email, &c.username, &c.passwordHash, &c.role, &c.firstName, &middle, &c.lastName, &c.status)
	if db.IsNoRows(err) {
		return credentials{}, false, nil
	}
	if err != nil {
		return credentials{}, false, fmt.Errorf("account: %w", err)
	}
	if c.id, err = uuid.Parse(id); err != nil {
		return credentials{}, false, httpx.Upstream("stored id: %v", err)
	}
	if email.Valid {
		c.email = &email.String
	}
	if middle.Valid {
		c.middleName = &middle.String
	}
	return c, true, nil
}

// byIdentifier finds an account by email or username. Both are stored lowercase, so
// one lowercased needle matches either column.
func (s store) byIdentifier(ctx context.Context, identifier string) (credentials, bool, error) {
	return scanCredentials(s.db.QueryRowContext(ctx,
		`select `+credentialColumns+` from users where email = ?1 or username = ?1`, identifier))
}

// byID finds an account by id; a missing one is httpx.ErrNotFound.
func (s store) byID(ctx context.Context, id uuid.UUID) (credentials, error) {
	c, found, err := scanCredentials(s.db.QueryRowContext(ctx,
		`select `+credentialColumns+` from users where id = ?1`, id.String()))
	if err != nil {
		return credentials{}, err
	}
	if !found {
		return credentials{}, httpx.ErrNotFound
	}
	return c, nil
}

// updateProfile writes the names and, when non-nil, a new email or username, and
// returns the stored row.
func (s store) updateProfile(ctx context.Context, id uuid.UUID, first string, middle *string, last string, email, username *string) (credentials, error) {
	c, found, err := scanCredentials(s.db.QueryRowContext(ctx, `update users
		set first_name = ?1, middle_name = ?2, last_name = ?3,
		    email = coalesce(?4, email), username = coalesce(?5, username),
		    updated_at = `+db.Now+`
		where id = ?6
		returning `+credentialColumns,
		first, middle, last, email, username, id.String()))
	if err != nil {
		return credentials{}, err
	}
	if !found {
		return credentials{}, httpx.ErrNotFound
	}
	return c, nil
}

func (s store) setPassword(ctx context.Context, id uuid.UUID, hash string) error {
	_, err := s.db.ExecContext(ctx, `update users set password_hash = ?1, updated_at = `+db.Now+` where id = ?2`,
		hash, id.String())
	if err != nil {
		return fmt.Errorf("account: set password: %w", err)
	}
	return nil
}
