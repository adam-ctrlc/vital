package db

import (
	"errors"
	"testing"
)

func TestEscapeLike(t *testing.T) {
	tests := []struct{ in, want string }{
		{`50%`, `50\%`},
		{`a_b`, `a\_b`},
		{`back\slash`, `back\\slash`},
		{`100%_\`, `100\%\_\\`},
		{`overload`, `overload`},
		{``, ``},
		{`ñ_ü`, `ñ\_ü`},
	}
	for _, tt := range tests {
		if got := EscapeLike(tt.in); got != tt.want {
			t.Errorf("EscapeLike(%q) = %q, want %q", tt.in, got, tt.want)
		}
	}
}

func TestIsUniqueViolation(t *testing.T) {
	tests := []struct {
		name string
		err  error
		want bool
	}{
		{"remote", errors.New("failed to execute SQL:\nSQLite error: UNIQUE constraint failed: users.username"), true},
		{"code only", errors.New(`code: "SQLITE_CONSTRAINT_UNIQUE"`), true},
		{"primary key", errors.New(`SQLITE_CONSTRAINT_PRIMARYKEY`), true},
		{"local", errors.New("constraint failed: UNIQUE constraint failed: alerts.kind (2067)"), true},
		{"other", errors.New("no such table: alerts"), false},
		{"nil", nil, false},
	}
	for _, tt := range tests {
		if got := IsUniqueViolation(tt.err); got != tt.want {
			t.Errorf("%s: got %v, want %v", tt.name, got, tt.want)
		}
	}
}
