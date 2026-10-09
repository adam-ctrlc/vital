// Package db opens the libSQL database and holds the SQL helpers every store shares.
//
// The database is Turso, reached over HTTP through libsql-client-go: pure Go, no cgo,
// and no connection budget to exhaust on serverless. database/sql's pool holds only
// handles; each statement is an HTTP request.
//
// Conventions every store follows (they are the schema's, see schema.sql):
//   - ids are text uuids; generate with uuid.NewString().
//   - timestamps are RFC 3339 text in UTC with millisecond precision and a Z, as
//     strftime('%Y-%m-%dT%H:%M:%fZ', 'now') writes them. Write "now" in SQL with that
//     expression (see Now), and read with wire.ParseTime.
//   - booleans are integers 0 and 1.
//   - placeholders are ?1, ?2, ... so one argument can be referenced twice.
package db

import (
	"context"
	"database/sql"
	"errors"
	"fmt"
	"strings"

	"github.com/tursodatabase/libsql-client-go/libsql"
)

// Now is the SQL expression for the current instant in the stored format.
const Now = "strftime('%Y-%m-%dT%H:%M:%fZ', 'now')"

// Open returns a handle to the database at url. It does no round trip, so a bad URL
// or an expired token surfaces on the first query rather than at startup, as with the
// Rust build: a cold start should not pay for a health check the first request
// performs anyway.
//
// A file: URL needs a SQLite driver registered under "sqlite", which only builds with
// the sqlite tag include (see sqlite.go). It exists for local development and tests.
func Open(url, token string) (*sql.DB, error) {
	var opts []libsql.Option
	if token != "" && !strings.HasPrefix(url, "file:") {
		opts = append(opts, libsql.WithAuthToken(token))
	}
	connector, err := libsql.NewConnector(url, opts...)
	if err != nil {
		return nil, fmt.Errorf("could not open the database: %w", err)
	}
	return sql.OpenDB(connector), nil
}

// IsUniqueViolation reports whether err is SQLite refusing a duplicate key.
//
// A concurrent insert can lose the pre-check race and still hit a unique index; that
// is the caller's conflict (409), not a server fault. Over HTTP the server's error
// code is lost and only its message survives, so the text is what is checked, as it
// was in Rust.
func IsUniqueViolation(err error) bool {
	if err == nil {
		return false
	}
	msg := err.Error()
	return strings.Contains(msg, "UNIQUE constraint failed") ||
		strings.Contains(msg, "SQLITE_CONSTRAINT_UNIQUE") ||
		strings.Contains(msg, "SQLITE_CONSTRAINT_PRIMARYKEY")
}

// EscapeLike escapes LIKE wildcards in a free-text needle so user input matches
// literally. Pair it with `escape '\'` in the SQL: SQLite has no default escape
// character, and without the clause the escaped needle would match nothing.
func EscapeLike(needle string) string {
	var b strings.Builder
	b.Grow(len(needle))
	for _, r := range needle {
		switch r {
		case '\\', '%', '_':
			b.WriteByte('\\')
		}
		b.WriteRune(r)
	}
	return b.String()
}

// ApplySchema runs each statement of a schema file in turn and reports how many ran.
//
// Statements are split on ";\n". Comment lines are stripped rather than used to skip
// the chunk: every statement in schema.sql is preceded by an explanation, so skipping
// commented chunks would skip most of the schema.
func ApplySchema(ctx context.Context, conn *sql.DB, schema string) (int, error) {
	applied := 0
	for _, chunk := range strings.Split(schema, ";\n") {
		var lines []string
		for _, line := range strings.Split(chunk, "\n") {
			if !strings.HasPrefix(strings.TrimSpace(line), "--") {
				lines = append(lines, line)
			}
		}
		stmt := strings.TrimSpace(strings.Join(lines, "\n"))
		if stmt == "" {
			continue
		}
		if _, err := conn.ExecContext(ctx, stmt); err != nil {
			return applied, fmt.Errorf("schema failed: %w", err)
		}
		applied++
	}
	return applied, nil
}

// ErrNoRows is sql.ErrNoRows, re-exported so stores can match it without importing
// database/sql only for that.
var ErrNoRows = sql.ErrNoRows

// IsNoRows reports whether err means the query matched nothing.
func IsNoRows(err error) bool { return errors.Is(err, sql.ErrNoRows) }
