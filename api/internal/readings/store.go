package readings

import (
	"context"
	"database/sql"
	"fmt"

	"github.com/adam-ctrlc/vital/api/internal/db"
	"github.com/adam-ctrlc/vital/api/internal/httpx"
	"github.com/adam-ctrlc/vital/api/internal/settings"
	"github.com/adam-ctrlc/vital/api/internal/wire"
)

// Store runs the readings SQL.
type Store struct {
	db *sql.DB
}

// NewStore returns a store over conn.
func NewStore(conn *sql.DB) *Store { return &Store{db: conn} }

// Insert stores a reading that has already been evaluated and returns the stored row.
// recorded_at is left to the column default.
//
// QueryRowContext reads the one returned row and closes the result set, so the
// connection is clean for the alert evaluation that follows (the Rust API had to
// drain it by hand; a half-read stream broke the next statement).
func (s *Store) Insert(ctx context.Context, in Input, apparent *float64, status Status, source string) (Reading, error) {
	r, err := scanReading(s.db.QueryRowContext(ctx, insertReadingSQL,
		nullable(in.VoltageV), nullable(in.CurrentA), nullable(in.TemperatureC), nullable(apparent),
		string(status), source,
		nullable(in.PowerW), nullable(in.PowerFactor), nullable(in.FrequencyHz), nullable(in.EnergyKwh),
		boolInt(in.RelayClosed)))
	if db.IsNoRows(err) {
		return Reading{}, httpx.Upstream("the reading insert returned no row")
	}
	if err != nil {
		return Reading{}, fmt.Errorf("insert reading: %w", err)
	}
	return r, nil
}

// RecordSample stores a simulator sample unless one was already written within the
// interval. It returns nil, with no error, when another request got there first, so
// only the writer evaluates alerts. An empty input is skipped silently: nobody asked
// for this write, so there is nobody to report it to.
func (s *Store) RecordSample(ctx context.Context, in Input, sampleIntervalMs int64, loadThresholdVA float64) (*Reading, error) {
	if in.IsEmpty() {
		return nil, nil
	}
	apparent, status := Evaluate(in, loadThresholdVA)
	r, err := scanReading(s.db.QueryRowContext(ctx, recordSampleSQL,
		nullable(in.VoltageV), nullable(in.CurrentA), nullable(in.TemperatureC), nullable(apparent),
		string(status),
		nullable(in.PowerW), nullable(in.PowerFactor), nullable(in.FrequencyHz), nullable(in.EnergyKwh),
		boolInt(in.RelayClosed),
		sampleWindowModifier(sampleIntervalMs)))
	if db.IsNoRows(err) {
		return nil, nil
	}
	if err != nil {
		return nil, fmt.Errorf("record sample: %w", err)
	}
	return &r, nil
}

// LatestHardware is the newest reading a board pushed, or nil when there is none.
func (s *Store) LatestHardware(ctx context.Context) (*Reading, error) {
	r, err := scanReading(s.db.QueryRowContext(ctx, latestHardwareSQL))
	if db.IsNoRows(err) {
		return nil, nil
	}
	if err != nil {
		return nil, fmt.Errorf("latest hardware reading: %w", err)
	}
	return &r, nil
}

// liveState is everything the live endpoint needs before it can decide anything,
// read in one round trip: this runs once a second per open dashboard.
type liveState struct {
	settings settings.Settings
	// latestSimulatorMs is the newest simulator sample in whole-second epoch
	// milliseconds, nil when there is none.
	latestSimulatorMs *int64
	// deviceIP is the board's last reported LAN address.
	deviceIP *string
}

// liveState loads the settings row, the newest simulator sample time and the board's
// address. A missing settings row is a 502, as in the Rust API.
func (s *Store) liveState(ctx context.Context) (liveState, error) {
	var (
		st                liveState
		load, trip, temp  float64
		updatedAt         string
		latestSimulatorMs sql.NullInt64
		deviceIP          sql.NullString
	)
	err := s.db.QueryRowContext(ctx, liveStateSQL).Scan(
		&load, &trip, &temp, &st.settings.RecloseDelaySeconds, &st.settings.TripConfirmSeconds,
		&st.settings.SourceMode, &updatedAt, &latestSimulatorMs, &deviceIP)
	if db.IsNoRows(err) {
		return liveState{}, httpx.Upstream("the live state query returned no row")
	}
	if err != nil {
		return liveState{}, fmt.Errorf("live state: %w", err)
	}
	at, err := parseStored(updatedAt)
	if err != nil {
		return liveState{}, err
	}
	st.settings.LoadThresholdVA = wire.Float(load)
	st.settings.TripThresholdVA = wire.Float(trip)
	st.settings.TempThresholdC = wire.Float(temp)
	st.settings.UpdatedAt = at
	if latestSimulatorMs.Valid {
		st.latestSimulatorMs = &latestSimulatorMs.Int64
	}
	if deviceIP.Valid {
		st.deviceIP = &deviceIP.String
	}
	return st, nil
}

// History returns one page of the filtered log and the count of every match.
func (s *Store) History(ctx context.Context, f HistoryFilter) ([]Reading, int64, error) {
	var total int64
	if err := s.db.QueryRowContext(ctx, historyCountSQL, f.FilterArgs()...).Scan(&total); err != nil {
		return nil, 0, fmt.Errorf("count readings: %w", err)
	}

	rows, err := s.db.QueryContext(ctx, f.SelectSQL(), f.SelectArgs()...)
	if err != nil {
		return nil, 0, fmt.Errorf("list readings: %w", err)
	}
	defer rows.Close()

	readings := []Reading{}
	for rows.Next() {
		r, err := scanReading(rows)
		if err != nil {
			return nil, 0, fmt.Errorf("list readings: %w", err)
		}
		readings = append(readings, r)
	}
	if err := rows.Err(); err != nil {
		return nil, 0, fmt.Errorf("list readings: %w", err)
	}
	return readings, total, nil
}

// Trend returns one point per UTC day over the last days days, oldest first.
func (s *Store) Trend(ctx context.Context, days int64) ([]TrendPoint, error) {
	rows, err := s.db.QueryContext(ctx, trendSQL, trendWindowModifier(days))
	if err != nil {
		return nil, fmt.Errorf("trend: %w", err)
	}
	defer rows.Close()

	points := []TrendPoint{}
	for rows.Next() {
		var (
			p                 TrendPoint
			day               string
			avgVA, maxVA, avg sql.NullFloat64
		)
		if err := rows.Scan(&day, &avgVA, &maxVA, &avg, &p.Samples); err != nil {
			return nil, fmt.Errorf("trend: %w", err)
		}
		if p.Day, err = parseStored(day); err != nil {
			return nil, err
		}
		p.AvgPowerVA, p.MaxPowerVA, p.AvgTemperatureC = nullFloat(avgVA), nullFloat(maxVA), nullFloat(avg)
		points = append(points, p)
	}
	if err := rows.Err(); err != nil {
		return nil, fmt.Errorf("trend: %w", err)
	}
	return points, nil
}

// rowScanner is a *sql.Row or *sql.Rows.
type rowScanner interface {
	Scan(dest ...any) error
}

// scanReading decodes a row selected as readingColumns, by position.
func scanReading(row rowScanner) (Reading, error) {
	var (
		r                                       Reading
		voltage, current, temperature, apparent sql.NullFloat64
		power, powerFactor, frequency, energy   sql.NullFloat64
		relayClosed                             sql.NullInt64
		recordedAt                              string
	)
	if err := row.Scan(&r.ID, &voltage, &current, &temperature, &apparent, &r.Status, &r.Source,
		&power, &powerFactor, &frequency, &energy, &relayClosed, &recordedAt); err != nil {
		return Reading{}, err
	}
	at, err := parseStored(recordedAt)
	if err != nil {
		return Reading{}, err
	}
	r.VoltageV, r.CurrentA, r.TemperatureC, r.ApparentPowerVA = nullFloat(voltage), nullFloat(current), nullFloat(temperature), nullFloat(apparent)
	r.PowerW, r.PowerFactor, r.FrequencyHz, r.EnergyKwh = nullFloat(power), nullFloat(powerFactor), nullFloat(frequency), nullFloat(energy)
	if relayClosed.Valid {
		closed := relayClosed.Int64 != 0
		r.RelayClosed = &closed
	}
	r.RecordedAt = at
	return r, nil
}

// parseStored reads a stored timestamp. An unreadable one is a 502, as the Rust
// API reported it, rather than a guess.
func parseStored(raw string) (wire.Time, error) {
	at, err := wire.ParseTime(raw)
	if err != nil {
		return wire.Time{}, httpx.Upstream("unreadable timestamp %q: %v", raw, err)
	}
	return wire.Time{Time: at}, nil
}

func nullFloat(v sql.NullFloat64) *wire.Float {
	if !v.Valid {
		return nil
	}
	return wire.Ptr(v.Float64)
}

// boolInt binds an optional boolean as the 0/1 integer the schema stores, or NULL.
func boolInt(b *bool) any {
	switch {
	case b == nil:
		return nil
	case *b:
		return int64(1)
	default:
		return int64(0)
	}
}
