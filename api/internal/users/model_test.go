package users

import "testing"

func TestCleanUsername(t *testing.T) {
	tests := map[string]string{
		"JDelaCruz":      "jdelacruz",
		"j.dela-cruz 2":  "jdelacruz2",
		"  Ñiño_Peña ":   "iopea",
		"":               "",
		"___":            "",
		"ABC123xyz":      "abc123xyz",
		"user@example.c": "userexamplec",
	}
	for in, want := range tests {
		if got := CleanUsername(in); got != want {
			t.Errorf("CleanUsername(%q) = %q, want %q", in, got, want)
		}
	}
}

func TestUsernameBase(t *testing.T) {
	tests := []struct{ first, last, want string }{
		{"Juan", "Dela Cruz", "jdelacruz"},
		{"  maria ", " Santos ", "msantos"},
		{"Ñora", "Peña", "pea"}, // a non-ASCII initial is dropped by cleaning, as in Rust
		{"", "", "user"},
		{"!!", "??", "user"},
		{"A", "", "a"},
	}
	for _, tt := range tests {
		if got := usernameBase(tt.first, tt.last); got != tt.want {
			t.Errorf("usernameBase(%q, %q) = %q, want %q", tt.first, tt.last, got, tt.want)
		}
	}
}

func TestFullName(t *testing.T) {
	s := func(v string) *string { return &v }
	tests := []struct {
		first  string
		middle *string
		last   string
		want   string
	}{
		{"Juan", s("Santos"), "Dela Cruz", "Juan Santos Dela Cruz"},
		{"Juan", nil, "Dela Cruz", "Juan Dela Cruz"},
		{" Juan ", s("  "), " Cruz ", "Juan Cruz"},
		{"", nil, "", ""},
	}
	for _, tt := range tests {
		if got := FullName(tt.first, tt.middle, tt.last); got != tt.want {
			t.Errorf("FullName = %q, want %q", got, tt.want)
		}
	}
}

func TestCleanOptionalAndEmail(t *testing.T) {
	s := func(v string) *string { return &v }
	if CleanOptional(nil) != nil || CleanOptional(s("   ")) != nil {
		t.Error("blank should be nil")
	}
	if got := CleanOptional(s(" x ")); got == nil || *got != "x" {
		t.Errorf("got %v", got)
	}
	if got := CleanEmail(s(" A@B.com ")); got == nil || *got != "a@b.com" {
		t.Errorf("got %v", got)
	}
}
