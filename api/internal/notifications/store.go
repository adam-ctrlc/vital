package notifications

import (
	"context"
	"database/sql"
	"fmt"

	"github.com/google/uuid"
)

// Store reads and writes push_tokens.
type Store struct {
	db *sql.DB
}

var _ DeviceLister = (*Store)(nil)

// NewStore returns a store over conn.
func NewStore(conn *sql.DB) *Store { return &Store{db: conn} }

// Register stores reg for user, moving the token to user if another account had it.
func (s *Store) Register(ctx context.Context, user uuid.UUID, reg Registration) error {
	if _, err := s.db.ExecContext(ctx, SQLRegisterToken, reg.Token, user.String(), reg.Platform, reg.ChannelID); err != nil {
		return fmt.Errorf("register push token: %w", err)
	}
	return nil
}

// Unregister removes user's own registration of token, if any.
func (s *Store) Unregister(ctx context.Context, user uuid.UUID, token string) error {
	if _, err := s.db.ExecContext(ctx, SQLUnregisterToken, token, user.String()); err != nil {
		return fmt.Errorf("unregister push token: %w", err)
	}
	return nil
}

// Devices implements DeviceLister.
func (s *Store) Devices(ctx context.Context) ([]Device, error) {
	rows, err := s.db.QueryContext(ctx, SQLDevices)
	if err != nil {
		return nil, fmt.Errorf("load push tokens: %w", err)
	}
	defer rows.Close()

	var out []Device
	for rows.Next() {
		var (
			d       Device
			channel sql.NullString
		)
		if err := rows.Scan(&d.Token, &channel); err != nil {
			return nil, fmt.Errorf("load push tokens: %w", err)
		}
		if channel.Valid {
			d.ChannelID = &channel.String
		}
		out = append(out, d)
	}
	if err := rows.Err(); err != nil {
		return nil, fmt.Errorf("load push tokens: %w", err)
	}
	return out, nil
}
