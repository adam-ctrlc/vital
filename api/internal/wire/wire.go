// Package wire holds the JSON encodings the Rust API produced, so responses stay
// byte-compatible with the clients already deployed against it.
//
// encoding/json and serde disagree in two places that matter here:
//
//   - Floats. serde_json writes 900.0 where encoding/json writes 900, and switches to
//     exponent form at 1e16 rather than 1e21. Float reproduces serde_json.
//   - Timestamps. chrono writes 0, 3, 6 or 9 fractional digits (whichever is exact)
//     where time.RFC3339Nano trims trailing zeros. Time reproduces chrono.
//
// Both matter mostly to the ESP32, whose JSON parser is smaller than a browser's, and
// to anything that compares responses textually.
package wire

import (
	"fmt"
	"math"
	"strconv"
	"strings"
	"time"
)

// Float is a float64 that marshals the way serde_json does.
//
// Use *Float for a nullable measurement: a nil pointer marshals as null, which is
// what serde writes for Option::None.
type Float float64

// MarshalJSON writes the shortest round-tripping representation in serde_json's
// format. NaN and infinities become null, as serde_json writes them.
func (f Float) MarshalJSON() ([]byte, error) {
	return []byte(FormatFloat(float64(f))), nil
}

// FormatFloat renders v exactly as serde_json would.
//
// serde_json prints in plain decimal when the decimal exponent is in [-5, 16), always
// with a fractional part ("900.0"), and in exponent form otherwise with an explicit
// sign and no zero padding ("1e+16", "1.5e-7").
func FormatFloat(v float64) string {
	if math.IsNaN(v) || math.IsInf(v, 0) {
		return "null"
	}

	// Shortest digits that round trip, in exponent form, to learn the exponent.
	sci := strconv.FormatFloat(v, 'e', -1, 64)
	mantissa, exponent, _ := strings.Cut(sci, "e")
	exp, _ := strconv.Atoi(exponent)

	if v == 0 || (exp >= -5 && exp < 16) {
		plain := strconv.FormatFloat(v, 'f', -1, 64)
		if !strings.ContainsRune(plain, '.') {
			plain += ".0"
		}
		return plain
	}

	sign := "+"
	if exp < 0 {
		sign = "-"
		exp = -exp
	}
	return fmt.Sprintf("%se%s%d", mantissa, sign, exp)
}

// Ptr returns a pointer to v as a Float, for building nullable fields.
func Ptr(v float64) *Float {
	f := Float(v)
	return &f
}

// Time is a UTC instant that marshals the way chrono's DateTime<Utc> does.
type Time struct{ time.Time }

// MarshalJSON writes RFC 3339 in UTC with a Z, using 0, 3, 6 or 9 fractional digits:
// the fewest of those that represent the instant exactly.
func (t Time) MarshalJSON() ([]byte, error) {
	return []byte(`"` + FormatTime(t.Time) + `"`), nil
}

// FormatTime renders an instant exactly as chrono serializes a DateTime<Utc>.
func FormatTime(t time.Time) string {
	t = t.UTC()
	base := t.Format("2006-01-02T15:04:05")
	nanos := t.Nanosecond()

	switch {
	case nanos == 0:
		return base + "Z"
	case nanos%1_000_000 == 0:
		return fmt.Sprintf("%s.%03dZ", base, nanos/1_000_000)
	case nanos%1_000 == 0:
		return fmt.Sprintf("%s.%06dZ", base, nanos/1_000)
	default:
		return fmt.Sprintf("%s.%09dZ", base, nanos)
	}
}

// ParseTime reads a timestamp column. The database stores RFC 3339 text, normally
// strftime('%Y-%m-%dT%H:%M:%fZ'), so millisecond precision and a Z.
func ParseTime(raw string) (time.Time, error) {
	t, err := time.Parse(time.RFC3339Nano, raw)
	if err != nil {
		return time.Time{}, fmt.Errorf("stored timestamp %q: %w", raw, err)
	}
	return t.UTC(), nil
}

// StorageFormat is the layout the schema's strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
// defaults produce. Use it when a timestamp is written from Go rather than SQL, so
// both sort and compare the same as text.
const StorageFormat = "2006-01-02T15:04:05.000Z"

// FormatStorage renders an instant the way the schema stores timestamps.
func FormatStorage(t time.Time) string {
	return t.UTC().Format(StorageFormat)
}

// local is Philippine time. A fixed offset: the country does not observe DST.
var local = time.FixedZone("PHT", 8*3600)

// LocalLabel renders an instant in local time for people, e.g. "August 14, 2026 1:00 PM".
// The raw value stays UTC for machines.
func LocalLabel(t time.Time) string {
	return t.In(local).Format("January 2, 2006 3:04 PM")
}
