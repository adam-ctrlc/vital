package alerts

import (
	"context"
	"database/sql"
	"fmt"

	"github.com/google/uuid"

	"github.com/adam-ctrlc/vital/api/internal/db"
)

// Store reads and writes the alerts table.
type Store struct {
	db *sql.DB
}

var _ RaiseStore = (*Store)(nil)

// NewStore returns a store over conn.
func NewStore(conn *sql.DB) *Store { return &Store{db: conn} }

// List returns one window of alerts matching q, newest first, and how many match in
// all. The count is a separate statement so total covers every match.
func (s *Store) List(ctx context.Context, q ListQuery) ([]AlertWithReading, int64, error) {
	var total int64
	if err := s.db.QueryRowContext(ctx, SQLCountAlerts, q.countArgs()...).Scan(&total); err != nil {
		return nil, 0, fmt.Errorf("count alerts: %w", err)
	}

	rows, err := s.db.QueryContext(ctx, SQLListAlerts, q.rowArgs()...)
	if err != nil {
		return nil, 0, fmt.Errorf("list alerts: %w", err)
	}
	defer rows.Close()

	var out []AlertWithReading
	for rows.Next() {
		a, err := ScanAlertWithReading(rows)
		if err != nil {
			return nil, 0, err
		}
		out = append(out, a)
	}
	if err := rows.Err(); err != nil {
		return nil, 0, fmt.Errorf("list alerts: %w", err)
	}
	return out, total, nil
}

// Acknowledge marks an open alert acknowledged by user and returns it. ok is false
// when the alert does not exist or was already acknowledged.
func (s *Store) Acknowledge(ctx context.Context, id int64, user uuid.UUID) (Alert, bool, error) {
	return one(s.db.QueryRowContext(ctx, SQLAcknowledgeAlert, user.String(), id))
}

// ClaimRenotify implements RaiseStore.
func (s *Store) ClaimRenotify(ctx context.Context, kind Kind, afterSeconds int64) (Alert, bool, error) {
	return one(s.db.QueryRowContext(ctx, SQLClaimRenotify, string(kind), afterSeconds))
}

// ActiveID implements RaiseStore.
func (s *Store) ActiveID(ctx context.Context, kind Kind) (int64, bool, error) {
	var id int64
	err := s.db.QueryRowContext(ctx, SQLActiveAlertID, string(kind)).Scan(&id)
	if db.IsNoRows(err) {
		return 0, false, nil
	}
	if err != nil {
		return 0, false, fmt.Errorf("active alert: %w", err)
	}
	return id, true, nil
}

// Open implements RaiseStore. Losing the race to a concurrent insert of the same
// kind is not an error: alerts_one_active_per_kind refused it, which is the point.
func (s *Store) Open(ctx context.Context, readingID int64, c Condition) (Alert, bool, error) {
	a, ok, err := one(s.db.QueryRowContext(ctx, SQLOpenAlert,
		readingID, string(c.Kind), c.Message, c.Value, c.Threshold))
	if db.IsUniqueViolation(err) {
		return Alert{}, false, nil
	}
	return a, ok, err
}

// one reads the single alert a returning statement produced, ok false when none.
func one(row *sql.Row) (Alert, bool, error) {
	a, err := ScanAlert(row)
	if db.IsNoRows(err) {
		return Alert{}, false, nil
	}
	if err != nil {
		return Alert{}, false, err
	}
	return a, true, nil
}
