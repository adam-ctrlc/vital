//go:build sqlite

package db

// Registers a pure-Go SQLite driver as "sqlite" so DATABASE_URL may be a local
// file:/path/to/dev.db. Development and tests only: build with -tags sqlite. The
// production build (and Vercel) leaves it out and speaks HTTP to Turso.
import _ "modernc.org/sqlite"
