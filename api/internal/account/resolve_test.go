package account

import (
	"errors"
	"testing"

	"github.com/adam-ctrlc/vital/api/internal/httpx"
)

func s(v string) *string { return &v }

func TestResolveEmail(t *testing.T) {
	tests := []struct {
		name     string
		admin    bool
		provided *string
		current  *string
		want     *string
		status   int
	}{
		{"absent", false, nil, s("a@b.c"), nil, 0},
		{"blank leaves alone", false, s("  "), nil, nil, 0},
		{"user resends own", false, s(" A@B.C "), s("a@b.c"), nil, 0},
		{"user changes", false, s("x@b.c"), s("a@b.c"), nil, 403},
		{"user without email sets one", false, s("x@b.c"), nil, nil, 403},
		{"admin changes", true, s(" X@B.C"), s("a@b.c"), s("x@b.c"), 0},
		{"admin invalid", true, s("nope"), nil, nil, 400},
	}
	for _, tt := range tests {
		got, err := resolveEmail(tt.admin, tt.provided, tt.current)
		checkResolve(t, tt.name, got, err, tt.want, tt.status)
	}
}

func TestResolveUsername(t *testing.T) {
	tests := []struct {
		name     string
		admin    bool
		provided *string
		current  string
		want     *string
		status   int
	}{
		{"absent", false, nil, "jdoe", nil, 0},
		{"user resends own", false, s("J.Doe"), "jdoe", nil, 0},
		{"user changes", false, s("other"), "jdoe", nil, 403},
		{"user blank", false, s(""), "jdoe", nil, 403},
		{"admin changes", true, s("New Name"), "jdoe", s("newname"), 0},
		{"admin blank", true, s("--"), "jdoe", nil, 400},
	}
	for _, tt := range tests {
		got, err := resolveUsername(tt.admin, tt.provided, tt.current)
		checkResolve(t, tt.name, got, err, tt.want, tt.status)
	}
}

func checkResolve(t *testing.T, name string, got *string, err error, want *string, status int) {
	t.Helper()
	if status != 0 {
		var apiErr *httpx.Error
		if !errors.As(err, &apiErr) || apiErr.Status != status {
			t.Errorf("%s: err = %v, want status %d", name, err, status)
		}
		return
	}
	if err != nil {
		t.Errorf("%s: unexpected error %v", name, err)
		return
	}
	if (got == nil) != (want == nil) || (got != nil && *got != *want) {
		t.Errorf("%s: got %v, want %v", name, deref(got), deref(want))
	}
}

func deref(p *string) any {
	if p == nil {
		return nil
	}
	return *p
}
