package readings

import (
	"fmt"
	"strings"
	"time"

	"github.com/adam-ctrlc/vital/api/internal/wire"
)

// parseRFC3339 reads an instant the way chrono's DateTime::parse_from_rfc3339 did, so
// the history filters accept exactly what the Rust API accepted.
//
// chrono is more lenient than time.RFC3339 in two ways, both reproduced: the date and
// time may be separated by 't' or a space as well as 'T', and the zone may be a
// lowercase 'z'. It is stricter in one: a comma before the fractional seconds is
// refused, where Go would take it. One difference remains: chrono accepts a leap
// second (":60"), which time.Parse refuses.
func parseRFC3339(raw string) (time.Time, error) {
	if strings.ContainsRune(raw, ',') {
		return time.Time{}, fmt.Errorf("parse %q: comma is not a fractional separator", raw)
	}
	b := []byte(raw)
	if len(b) > 10 && (b[10] == 't' || b[10] == ' ') {
		b[10] = 'T'
	}
	if n := len(b); n > 0 && b[n-1] == 'z' {
		b[n-1] = 'Z'
	}
	at, err := time.Parse(time.RFC3339, string(b))
	if err != nil {
		return time.Time{}, fmt.Errorf("parse %q: %w", raw, err)
	}
	return at.UTC(), nil
}

// storedInstant rewrites an RFC 3339 instant into the exact shape recorded_at is
// stored in (UTC, milliseconds, Z), so a bound compares as text in the same order as
// time. Extra precision is truncated, as chrono's %.3f did.
func storedInstant(raw string) (string, error) {
	at, err := parseRFC3339(raw)
	if err != nil {
		return "", err
	}
	return wire.FormatStorage(at), nil
}
