// Package config reads the environment, with the same names, defaults and validation
// as the Rust API's src/config.rs, so one set of Vercel environment variables serves
// either build.
package config

import (
	"fmt"
	"os"
	"strconv"
	"strings"
)

// DefaultSampleIntervalMS is how often a reading is written to storage.
//
// Not how often the dashboard updates: that polls every second and stays live. A
// transformer's thermal behaviour moves over minutes, so storing every 1.5s bought no
// insight and filled the database roughly ten times faster.
const DefaultSampleIntervalMS int64 = 15_000

// Config is the process configuration.
type Config struct {
	// DatabaseURL is the libSQL endpoint, accepted as libsql:// or https:// and
	// normalized to https://. A file: URL is passed through, for local development
	// builds that include a SQLite driver (see internal/db).
	DatabaseURL   string
	DatabaseToken string
	JWTSecret     string
	Port          uint16
	// SimulatorEnabled and SampleIntervalMS are read now for parity with the Rust
	// config; the readings routes consume them.
	SimulatorEnabled bool
	SampleIntervalMS int64
	// DeviceAPIKey is the ESP32's shared secret. Empty means unset, which rejects
	// every device request.
	DeviceAPIKey string
}

// Error reports a missing or unparseable variable. Its message matches the Rust
// AppError Display text ("missing environment variable: X").
type Error struct {
	Key     string
	Missing bool
}

func (e *Error) Error() string {
	if e.Missing {
		return "missing environment variable: " + e.Key
	}
	return "invalid environment variable: " + e.Key
}

// Load reads the configuration from the process environment.
func Load() (Config, error) {
	return load(os.LookupEnv)
}

func load(lookup func(string) (string, bool)) (Config, error) {
	var cfg Config
	var err error

	// Required means present: like Rust's env::var, a variable set to "" is accepted.
	required := func(key string) string {
		v, ok := lookup(key)
		if !ok && err == nil {
			err = &Error{Key: key, Missing: true}
		}
		return v
	}

	cfg.DatabaseURL = normalizeLibsql(required("DATABASE_URL"))
	cfg.DatabaseToken = required("DATABASE_AUTH_TOKEN")
	cfg.JWTSecret = required("JWT_SECRET")
	if err != nil {
		return Config{}, err
	}

	port, err := parsed(lookup, "PORT", uint16(8080), func(s string) (uint16, error) {
		v, err := strconv.ParseUint(s, 10, 16)
		return uint16(v), err
	})
	if err != nil {
		return Config{}, err
	}
	cfg.Port = port

	// Rust's bool::from_str accepts exactly "true" and "false"; strconv.ParseBool
	// would also take "1", "T" and friends.
	cfg.SimulatorEnabled, err = parsed(lookup, "SIMULATOR_ENABLED", true, func(s string) (bool, error) {
		switch s {
		case "true":
			return true, nil
		case "false":
			return false, nil
		}
		return false, fmt.Errorf("not a bool: %q", s)
	})
	if err != nil {
		return Config{}, err
	}

	cfg.SampleIntervalMS, err = parsed(lookup, "SAMPLE_INTERVAL_MS", DefaultSampleIntervalMS, func(s string) (int64, error) {
		return strconv.ParseInt(s, 10, 64)
	})
	if err != nil {
		return Config{}, err
	}

	v, _ := lookup("DEVICE_API_KEY")
	cfg.DeviceAPIKey = optionalSecret(v)

	return cfg, nil
}

// parsed reads an optional variable: unset yields the fallback, set but unparseable is
// an error rather than a silent fallback.
func parsed[T any](lookup func(string) (string, bool), key string, fallback T, parse func(string) (T, error)) (T, error) {
	raw, ok := lookup(key)
	if !ok {
		return fallback, nil
	}
	v, err := parse(raw)
	if err != nil {
		var zero T
		return zero, &Error{Key: key}
	}
	return v, nil
}

// normalizeLibsql accepts the scheme Turso displays and hands over the one the HTTP
// client wants.
func normalizeLibsql(url string) string {
	if rest, ok := strings.CutPrefix(url, "libsql://"); ok {
		return "https://" + rest
	}
	return url
}

// optionalSecret makes "set but blank" indistinguishable from unset, and drops the
// trailing newline a key piped in from a file tends to carry. Without this an empty
// DEVICE_API_KEY would match the empty x-device-key header any caller can send.
func optionalSecret(raw string) string {
	return strings.TrimSpace(raw)
}
