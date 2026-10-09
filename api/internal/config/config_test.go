package config

import (
	"bufio"
	"errors"
	"strings"
	"testing"
)

func env(vars map[string]string) func(string) (string, bool) {
	return func(k string) (string, bool) {
		v, ok := vars[k]
		return v, ok
	}
}

func base() map[string]string {
	return map[string]string{
		"DATABASE_URL":        "libsql://vital-adamskie.turso.io",
		"DATABASE_AUTH_TOKEN": "token",
		"JWT_SECRET":          "secret",
	}
}

func TestLoadDefaults(t *testing.T) {
	cfg, err := load(env(base()))
	if err != nil {
		t.Fatal(err)
	}
	if cfg.DatabaseURL != "https://vital-adamskie.turso.io" {
		t.Errorf("DatabaseURL = %q", cfg.DatabaseURL)
	}
	if cfg.Port != 8080 || !cfg.SimulatorEnabled || cfg.SampleIntervalMS != 15_000 || cfg.DeviceAPIKey != "" {
		t.Errorf("defaults = %+v", cfg)
	}
}

func TestLoadErrors(t *testing.T) {
	tests := []struct {
		name    string
		mutate  func(map[string]string)
		wantMsg string
	}{
		{"missing secret", func(m map[string]string) { delete(m, "JWT_SECRET") }, "missing environment variable: JWT_SECRET"},
		{"missing url", func(m map[string]string) { delete(m, "DATABASE_URL") }, "missing environment variable: DATABASE_URL"},
		{"bad port", func(m map[string]string) { m["PORT"] = "70000" }, "invalid environment variable: PORT"},
		{"blank port", func(m map[string]string) { m["PORT"] = "" }, "invalid environment variable: PORT"},
		{"rust bool only", func(m map[string]string) { m["SIMULATOR_ENABLED"] = "1" }, "invalid environment variable: SIMULATOR_ENABLED"},
		{"bad interval", func(m map[string]string) { m["SAMPLE_INTERVAL_MS"] = "fast" }, "invalid environment variable: SAMPLE_INTERVAL_MS"},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			vars := base()
			tt.mutate(vars)
			_, err := load(env(vars))
			var cfgErr *Error
			if !errors.As(err, &cfgErr) || err.Error() != tt.wantMsg {
				t.Fatalf("err = %v, want %q", err, tt.wantMsg)
			}
		})
	}
}

func TestBlankRequiredIsAccepted(t *testing.T) {
	// Rust's env::var returns Ok("") for a variable set to nothing.
	vars := base()
	vars["DATABASE_AUTH_TOKEN"] = ""
	if _, err := load(env(vars)); err != nil {
		t.Fatal(err)
	}
}

func TestDeviceKeyIsTrimmedAndBlankMeansUnset(t *testing.T) {
	tests := map[string]string{"": "", "   ": "", "  s3cret\n": "s3cret", "s3cret": "s3cret"}
	for in, want := range tests {
		vars := base()
		vars["DEVICE_API_KEY"] = in
		cfg, err := load(env(vars))
		if err != nil {
			t.Fatal(err)
		}
		if cfg.DeviceAPIKey != want {
			t.Errorf("DEVICE_API_KEY %q -> %q, want %q", in, cfg.DeviceAPIKey, want)
		}
	}
}

func TestHTTPSURLIsLeftAlone(t *testing.T) {
	if got := normalizeLibsql("https://x.turso.io"); got != "https://x.turso.io" {
		t.Error(got)
	}
}

func TestParseDotenv(t *testing.T) {
	src := "# comment\nA=1\nexport B=\"two words\"\nC='single'\nD=plain # trailing\n\nE=\n"
	got, err := parseDotenv(bufio.NewScanner(strings.NewReader(src)))
	if err != nil {
		t.Fatal(err)
	}
	want := map[string]string{"A": "1", "B": "two words", "C": "single", "D": "plain", "E": ""}
	for k, v := range want {
		if got[k] != v {
			t.Errorf("%s = %q, want %q", k, got[k], v)
		}
	}
}
