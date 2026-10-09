package users

import (
	"context"
	"database/sql"
	"fmt"
	"strconv"
	"strings"

	"github.com/google/uuid"

	"github.com/adam-ctrlc/vital/api/internal/auth"
	"github.com/adam-ctrlc/vital/api/internal/db"
	"github.com/adam-ctrlc/vital/api/internal/httpx"
	"github.com/adam-ctrlc/vital/api/internal/wire"
)

// columns is what every query that builds a User selects, in scanUser's order.
// full_name is composed in Go (FullName) rather than in SQL, so it has one definition.
const columns = "id, email, username, role, first_name, middle_name, last_name, created_at, status"

// Store is the users table.
type Store struct {
	db *sql.DB
}

// NewStore returns a store over conn.
func NewStore(conn *sql.DB) *Store { return &Store{db: conn} }

func scanUser(row interface{ Scan(...any) error }) (User, error) {
	var (
		u             User
		id, createdAt string
		email, middle sql.NullString
	)
	if err := row.Scan(&id, &email, &u.Username, &u.Role, &u.FirstName, &middle, &u.LastName, &createdAt, &u.Status); err != nil {
		return User{}, err
	}
	parsed, err := uuid.Parse(id)
	if err != nil {
		return User{}, httpx.Upstream("stored id: %v", err)
	}
	at, err := wire.ParseTime(createdAt)
	if err != nil {
		return User{}, httpx.Upstream("%v", err)
	}
	u.ID = parsed
	u.Email = nullable(email)
	u.MiddleName = nullable(middle)
	u.FullName = FullName(u.FirstName, u.MiddleName, u.LastName)
	u.CreatedAt = wire.Time{Time: at}
	return u, nil
}

func nullable(s sql.NullString) *string {
	if !s.Valid {
		return nil
	}
	return &s.String
}

// ListFilter narrows List. Nil fields do not filter; Query must already be escaped
// with db.EscapeLike.
type ListFilter struct {
	Role, Query, Status *string
}

// List returns every account matching f, oldest first.
//
// LIKE rather than ILIKE, which SQLite does not have and does not need: its LIKE is
// already case insensitive for ASCII. The escape clause is required; SQLite has no
// default escape character.
func (s *Store) List(ctx context.Context, f ListFilter) ([]User, error) {
	rows, err := s.db.QueryContext(ctx, `select `+columns+` from users
		where (?1 is null or role = ?1)
		  and (?2 is null
		       or email like '%' || ?2 || '%' escape '\'
		       or username like '%' || ?2 || '%' escape '\'
		       or first_name like '%' || ?2 || '%' escape '\'
		       or middle_name like '%' || ?2 || '%' escape '\'
		       or last_name like '%' || ?2 || '%' escape '\'
		       or trim(first_name || ' ' || coalesce(middle_name || ' ', '') || last_name)
		          like '%' || ?2 || '%' escape '\')
		  and (?3 is null or status = ?3)
		order by created_at`, f.Role, f.Query, f.Status)
	if err != nil {
		return nil, fmt.Errorf("users: list: %w", err)
	}
	defer rows.Close()

	list := []User{}
	for rows.Next() {
		u, err := scanUser(rows)
		if err != nil {
			return nil, fmt.Errorf("users: list: %w", err)
		}
		list = append(list, u)
	}
	if err := rows.Err(); err != nil {
		return nil, fmt.Errorf("users: list: %w", err)
	}
	return list, nil
}

// Get returns one account, or httpx.ErrNotFound.
func (s *Store) Get(ctx context.Context, id uuid.UUID) (User, error) {
	u, err := scanUser(s.db.QueryRowContext(ctx, `select `+columns+` from users where id = ?1`, id.String()))
	if db.IsNoRows(err) {
		return User{}, httpx.ErrNotFound
	}
	if err != nil {
		return User{}, fmt.Errorf("users: get: %w", err)
	}
	return u, nil
}

func (s *Store) exists(ctx context.Context, query string, arg any) (bool, error) {
	var one int
	err := s.db.QueryRowContext(ctx, query, arg).Scan(&one)
	if db.IsNoRows(err) {
		return false, nil
	}
	if err != nil {
		return false, err
	}
	return true, nil
}

// UsernameTaken reports whether an account holds name.
func (s *Store) UsernameTaken(ctx context.Context, name string) (bool, error) {
	taken, err := s.exists(ctx, `select 1 from users where username = ?1`, name)
	if err != nil {
		return false, fmt.Errorf("users: username taken: %w", err)
	}
	return taken, nil
}

// EmailTaken reports whether an account holds email. A nil email is never taken.
func (s *Store) EmailTaken(ctx context.Context, email *string) (bool, error) {
	if email == nil {
		return false, nil
	}
	taken, err := s.exists(ctx, `select 1 from users where email = ?1`, *email)
	if err != nil {
		return false, fmt.Errorf("users: email taken: %w", err)
	}
	return taken, nil
}

// SuggestUsername finds a free username derived from a name: the first initial and
// the surname, then a numeric suffix from 2 upwards.
//
// Advisory: two admins generating at once can be handed the same name, and the unique
// index on username is what turns the second insert into a 409.
func (s *Store) SuggestUsername(ctx context.Context, first, last string) (string, error) {
	base := usernameBase(first, last)
	candidate := base
	for suffix := 2; ; suffix++ {
		taken, err := s.UsernameTaken(ctx, candidate)
		if err != nil {
			return "", err
		}
		if !taken {
			return candidate, nil
		}
		candidate = base + strconv.Itoa(suffix)
	}
}

// Create inserts an account with status (StatusActive when an admin creates it,
// StatusPending when it registered itself).
func (s *Store) Create(ctx context.Context, in CreateInput, status string) error {
	hash, err := auth.HashPassword(in.Password)
	if err != nil {
		return httpx.ErrPasswordHash.With(err)
	}

	username := ""
	if in.Username != nil {
		username = CleanUsername(*in.Username)
	}
	if username == "" {
		if username, err = s.SuggestUsername(ctx, in.FirstName, in.LastName); err != nil {
			return err
		}
	}

	// The id is generated here: SQLite has no gen_random_uuid().
	_, err = s.db.ExecContext(ctx, `insert into users (id, email, username, password_hash, role,
			first_name, middle_name, last_name, status)
		values (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)`,
		uuid.NewString(), CleanEmail(in.Email), username, hash, string(in.Role),
		trim(in.FirstName), CleanOptional(in.MiddleName), trim(in.LastName), status)
	if err != nil {
		return fmt.Errorf("users: create: %w", err)
	}
	return nil
}

// Update applies an admin edit and returns the stored row, or httpx.ErrNotFound. A
// blank or absent username or password keeps the current value.
func (s *Store) Update(ctx context.Context, id uuid.UUID, in UpdateInput) (User, error) {
	var hash *string
	if in.Password != nil && *in.Password != "" {
		h, err := auth.HashPassword(*in.Password)
		if err != nil {
			return User{}, httpx.ErrPasswordHash.With(err)
		}
		hash = &h
	}

	var username *string
	if in.Username != nil {
		if c := CleanUsername(*in.Username); c != "" {
			username = &c
		}
	}

	u, err := scanUser(s.db.QueryRowContext(ctx, `update users
		set email = ?1, role = ?2, first_name = ?3, middle_name = ?4, last_name = ?5,
		    username = coalesce(?6, username),
		    password_hash = coalesce(?7, password_hash),
		    updated_at = `+db.Now+`
		where id = ?8
		returning `+columns,
		CleanEmail(in.Email), string(in.Role), trim(in.FirstName), CleanOptional(in.MiddleName),
		trim(in.LastName), username, hash, id.String()))
	if db.IsNoRows(err) {
		return User{}, httpx.ErrNotFound
	}
	if err != nil {
		return User{}, fmt.Errorf("users: update: %w", err)
	}
	return u, nil
}

// Approve activates a pending account and returns it, or httpx.ErrNotFound. Approving
// an account that is already active changes nothing and is not an error, so a second
// tap or two admins at once are harmless.
func (s *Store) Approve(ctx context.Context, id uuid.UUID) (User, error) {
	_, err := s.db.ExecContext(ctx, `update users set status = 'active', updated_at = `+db.Now+`
		where id = ?1 and status = 'pending'`, id.String())
	if err != nil {
		return User{}, fmt.Errorf("users: approve: %w", err)
	}
	return s.Get(ctx, id)
}

// RoleOf returns an account's role, or httpx.ErrNotFound.
func (s *Store) RoleOf(ctx context.Context, id uuid.UUID) (string, error) {
	var role string
	err := s.db.QueryRowContext(ctx, `select role from users where id = ?1`, id.String()).Scan(&role)
	if db.IsNoRows(err) {
		return "", httpx.ErrNotFound
	}
	if err != nil {
		return "", fmt.Errorf("users: role: %w", err)
	}
	return role, nil
}

// Delete removes an account and reports whether one was removed.
func (s *Store) Delete(ctx context.Context, id uuid.UUID) (bool, error) {
	res, err := s.db.ExecContext(ctx, `delete from users where id = ?1`, id.String())
	if err != nil {
		return false, fmt.Errorf("users: delete: %w", err)
	}
	n, err := res.RowsAffected()
	if err != nil {
		return false, fmt.Errorf("users: delete: %w", err)
	}
	return n > 0, nil
}

func trim(s string) string { return strings.TrimSpace(s) }
