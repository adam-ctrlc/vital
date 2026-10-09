// Package settings is the single row of operator thresholds (/api/v1/settings) and
// the store the readings and device routes read them through.
package settings

import (
	"context"
	"database/sql"
	"fmt"
	"net/http"

	"github.com/adam-ctrlc/vital/api/internal/auth"
	"github.com/adam-ctrlc/vital/api/internal/db"
	"github.com/adam-ctrlc/vital/api/internal/httpx"
	"github.com/adam-ctrlc/vital/api/internal/wire"
)

// Settings is the stored row.
type Settings struct {
	// LoadThresholdVA raises an alert and marks a reading as overload. Advisory:
	// nothing is switched.
	LoadThresholdVA wire.Float `json:"loadThresholdVa"`
	// TripThresholdVA opens the relay. Always above the alarm.
	TripThresholdVA wire.Float `json:"tripThresholdVa"`
	TempThresholdC  wire.Float `json:"tempThresholdC"`
	// RecloseDelaySeconds is how long the board waits before each reclose attempt.
	RecloseDelaySeconds int32 `json:"recloseDelaySeconds"`
	// TripConfirmSeconds is how long the load must stay above the trip level before
	// the contacts open.
	TripConfirmSeconds int32     `json:"tripConfirmSeconds"`
	SourceMode         string    `json:"sourceMode"`
	UpdatedAt          wire.Time `json:"updatedAt"`
}

// Update is the body of PUT /settings.
type Update struct {
	LoadThresholdVA     float64 `json:"loadThresholdVa" required:"true"`
	TripThresholdVA     float64 `json:"tripThresholdVa" required:"true"`
	TempThresholdC      float64 `json:"tempThresholdC" required:"true"`
	RecloseDelaySeconds int32   `json:"recloseDelaySeconds" required:"true"`
	// TripConfirmSeconds absent means "leave it as it is", not "reset it": a build in
	// somebody's hand still sends only the four fields it knew about.
	TripConfirmSeconds *int32 `json:"tripConfirmSeconds"`
}

// SourceUpdate is the body of PUT /settings/source.
type SourceUpdate struct {
	SourceMode string `json:"sourceMode" required:"true"`
}

// Validate applies the bounds the database also enforces, so the caller gets an
// explanation rather than a bare constraint failure.
func (u Update) Validate() error {
	switch {
	case u.LoadThresholdVA <= 0:
		return httpx.BadRequest("load threshold must be greater than zero")
	case u.TempThresholdC <= 0:
		return httpx.BadRequest("temperature threshold must be greater than zero")
	case u.TripThresholdVA <= u.LoadThresholdVA:
		// A trip at or below the alarm would open the relay in the same instant the
		// alert was raised, leaving nobody a window to shed load.
		return httpx.BadRequest("trip threshold must be greater than the alarm threshold")
	case u.RecloseDelaySeconds < 5 || u.RecloseDelaySeconds > 600:
		return httpx.BadRequest("reclose delay must be between 5 and 600 seconds")
	case u.TripConfirmSeconds != nil && (*u.TripConfirmSeconds < 1 || *u.TripConfirmSeconds > 60):
		// At zero the board would cut the load on every switch-on inrush.
		return httpx.BadRequest("trip delay must be between 1 and 60 seconds")
	}
	return nil
}

const columns = `load_threshold_va, trip_threshold_va, temp_threshold_c, reclose_delay_seconds,
	trip_confirm_seconds, source_mode, updated_at`

// Store reads and writes the settings row.
type Store struct {
	db *sql.DB
}

// NewStore returns a store over conn.
func NewStore(conn *sql.DB) *Store { return &Store{db: conn} }

// Load returns the settings.
func (s *Store) Load(ctx context.Context) (Settings, error) {
	return scan(s.db.QueryRowContext(ctx, `select `+columns+` from settings where id = 1`))
}

// Apply stores an operator's thresholds and returns the stored row, rather than
// re-reading it, so the response cannot describe a state a concurrent edit replaced.
func (s *Store) Apply(ctx context.Context, u Update) (Settings, error) {
	return scan(s.db.QueryRowContext(ctx, `update settings set load_threshold_va = ?1, trip_threshold_va = ?2,
			temp_threshold_c = ?3, reclose_delay_seconds = ?4,
			trip_confirm_seconds = coalesce(?5, trip_confirm_seconds),
			updated_at = `+db.Now+`
		where id = 1
		returning `+columns,
		u.LoadThresholdVA, u.TripThresholdVA, u.TempThresholdC, u.RecloseDelaySeconds, u.TripConfirmSeconds))
}

// SetSource switches between "simulation" and "hardware" and returns the stored row.
func (s *Store) SetSource(ctx context.Context, mode string) (Settings, error) {
	return scan(s.db.QueryRowContext(ctx, `update settings set source_mode = ?1, updated_at = `+db.Now+`
		where id = 1
		returning `+columns, mode))
}

func scan(row *sql.Row) (Settings, error) {
	var (
		st        Settings
		load      float64
		trip      float64
		temp      float64
		updatedAt string
	)
	err := row.Scan(&load, &trip, &temp, &st.RecloseDelaySeconds, &st.TripConfirmSeconds, &st.SourceMode, &updatedAt)
	if db.IsNoRows(err) {
		// The schema seeds id 1 and refuses any other, so a missing row is a broken
		// database rather than a missing resource; a 404 would tell the app the
		// settings screen does not exist.
		return Settings{}, httpx.Upstream("the settings row is missing")
	}
	if err != nil {
		return Settings{}, fmt.Errorf("settings: %w", err)
	}
	at, err := wire.ParseTime(updatedAt)
	if err != nil {
		return Settings{}, httpx.Upstream("unreadable timestamp %q: %v", updatedAt, err)
	}
	st.LoadThresholdVA, st.TripThresholdVA, st.TempThresholdC = wire.Float(load), wire.Float(trip), wire.Float(temp)
	st.UpdatedAt = wire.Time{Time: at}
	return st, nil
}

// Handler serves /api/v1/settings.
type Handler struct {
	store *Store
	guard *auth.Guard
}

// NewHandler returns the settings routes.
func NewHandler(store *Store, guard *auth.Guard) *Handler {
	return &Handler{store: store, guard: guard}
}

// Register mounts the routes on mux.
func (h *Handler) Register(mux *http.ServeMux) {
	const p = httpx.APIPrefix + "/settings"
	mux.Handle("GET "+p, h.guard.User(httpx.HandlerFunc(h.read)))
	mux.Handle("PUT "+p, h.guard.Admin(httpx.HandlerFunc(h.update)))
	mux.Handle("PUT "+p+"/source", h.guard.Admin(httpx.HandlerFunc(h.setSource)))
}

func (h *Handler) read(w http.ResponseWriter, r *http.Request) error {
	st, err := h.store.Load(r.Context())
	if err != nil {
		return err
	}
	httpx.WriteJSON(w, http.StatusOK, st)
	return nil
}

func (h *Handler) update(w http.ResponseWriter, r *http.Request) error {
	var u Update
	if err := httpx.DecodeJSON(r, &u); err != nil {
		return err
	}
	if err := u.Validate(); err != nil {
		return err
	}
	st, err := h.store.Apply(r.Context(), u)
	if err != nil {
		return err
	}
	httpx.WriteJSON(w, http.StatusOK, st)
	return nil
}

func (h *Handler) setSource(w http.ResponseWriter, r *http.Request) error {
	var u SourceUpdate
	if err := httpx.DecodeJSON(r, &u); err != nil {
		return err
	}
	if u.SourceMode != "simulation" && u.SourceMode != "hardware" {
		return httpx.BadRequest("source mode must be simulation or hardware")
	}
	st, err := h.store.SetSource(r.Context(), u.SourceMode)
	if err != nil {
		return err
	}
	httpx.WriteJSON(w, http.StatusOK, st)
	return nil
}
