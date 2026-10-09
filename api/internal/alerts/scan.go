package alerts

import (
	"database/sql"
	"fmt"
	"time"

	"github.com/google/uuid"

	"github.com/adam-ctrlc/vital/api/internal/httpx"
	"github.com/adam-ctrlc/vital/api/internal/wire"
)

// RowScanner is the part of *sql.Row and *sql.Rows the decoders need.
type RowScanner interface {
	Scan(dest ...any) error
}

// rawAlert holds alertColumns as the driver hands them back, before the text
// columns are parsed.
type rawAlert struct {
	id             int64
	readingID      sql.NullInt64
	kind           string
	message        string
	value          float64
	threshold      float64
	createdAt      string
	acknowledgedAt sql.NullString
	acknowledgedBy sql.NullString
	responseMS     sql.NullInt64
}

func (r *rawAlert) dest() []any {
	return []any{
		&r.id, &r.readingID, &r.kind, &r.message, &r.value, &r.threshold,
		&r.createdAt, &r.acknowledgedAt, &r.acknowledgedBy, &r.responseMS,
	}
}

func (r *rawAlert) alert() (Alert, error) {
	createdAt, err := parseTime(r.createdAt)
	if err != nil {
		return Alert{}, err
	}

	a := Alert{
		ID:         r.id,
		ReadingID:  nullInt(r.readingID),
		Kind:       Kind(r.kind),
		Message:    r.message,
		Value:      wire.Float(r.value),
		Threshold:  wire.Float(r.threshold),
		CreatedAt:  wire.Time{Time: createdAt},
		ResponseMS: nullInt(r.responseMS),
	}

	// Unacknowledged alerts have neither; SQLite has no date or uuid type, so both
	// arrive as text and are parsed here.
	if r.acknowledgedAt.Valid {
		at, err := parseTime(r.acknowledgedAt.String)
		if err != nil {
			return Alert{}, err
		}
		a.AcknowledgedAt = &wire.Time{Time: at}
	}
	if r.acknowledgedBy.Valid {
		by, err := uuid.Parse(r.acknowledgedBy.String)
		if err != nil {
			return Alert{}, httpx.Upstream("stored id: %v", err)
		}
		a.AcknowledgedBy = &by
	}

	return a, nil
}

// ScanAlert reads a row selected as alertColumns.
func ScanAlert(row RowScanner) (Alert, error) {
	var raw rawAlert
	if err := row.Scan(raw.dest()...); err != nil {
		return Alert{}, fmt.Errorf("scan alert: %w", err)
	}
	return raw.alert()
}

// ScanAlertWithReading reads a row selected as alertColumnsJoined followed by
// readingColumnsJoined, as SQLListAlerts does.
func ScanAlertWithReading(row RowScanner) (AlertWithReading, error) {
	var (
		raw      rawAlert
		measures [8]sql.NullFloat64
	)

	dest := raw.dest()
	for i := range measures {
		dest = append(dest, &measures[i])
	}
	if err := row.Scan(dest...); err != nil {
		return AlertWithReading{}, fmt.Errorf("scan alert with reading: %w", err)
	}

	a, err := raw.alert()
	if err != nil {
		return AlertWithReading{}, err
	}

	return AlertWithReading{
		Alert:           a,
		VoltageV:        nullFloat(measures[0]),
		CurrentA:        nullFloat(measures[1]),
		TemperatureC:    nullFloat(measures[2]),
		ApparentPowerVA: nullFloat(measures[3]),
		PowerW:          nullFloat(measures[4]),
		PowerFactor:     nullFloat(measures[5]),
		FrequencyHz:     nullFloat(measures[6]),
		EnergyKWh:       nullFloat(measures[7]),
	}, nil
}

// parseTime reads a stored timestamp. One that does not parse is a 502, as the Rust
// API's "upstream error: stored timestamp: ..." was: the database holds something it
// never should, which is not the caller's mistake.
func parseTime(raw string) (time.Time, error) {
	t, err := wire.ParseTime(raw)
	if err != nil {
		return time.Time{}, httpx.Upstream("%v", err)
	}
	return t, nil
}

func nullInt(v sql.NullInt64) *int64 {
	if !v.Valid {
		return nil
	}
	return &v.Int64
}

func nullFloat(v sql.NullFloat64) *wire.Float {
	if !v.Valid {
		return nil
	}
	return wire.Ptr(v.Float64)
}
