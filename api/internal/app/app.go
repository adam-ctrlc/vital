// Package app assembles the API: it opens the database, builds every route group and
// wraps them in the shared middleware. cmd/server and the Vercel entrypoint both
// serve what New returns.
package app

import (
	"database/sql"
	"net/http"
	"time"

	"github.com/adam-ctrlc/vital/api/internal/account"
	"github.com/adam-ctrlc/vital/api/internal/alerts"
	"github.com/adam-ctrlc/vital/api/internal/audit"
	"github.com/adam-ctrlc/vital/api/internal/auth"
	"github.com/adam-ctrlc/vital/api/internal/config"
	"github.com/adam-ctrlc/vital/api/internal/db"
	"github.com/adam-ctrlc/vital/api/internal/device"
	"github.com/adam-ctrlc/vital/api/internal/httpx"
	"github.com/adam-ctrlc/vital/api/internal/insights"
	"github.com/adam-ctrlc/vital/api/internal/notifications"
	"github.com/adam-ctrlc/vital/api/internal/readings"
	"github.com/adam-ctrlc/vital/api/internal/settings"
	"github.com/adam-ctrlc/vital/api/internal/users"
	"github.com/adam-ctrlc/vital/api/internal/wire"
)

// Deps is what route groups are built from. Add a field here when a new group needs
// a shared store, rather than constructing a second copy inside the group.
type Deps struct {
	Config   config.Config
	DB       *sql.DB
	Guard    *auth.Guard
	Users    *users.Store
	Settings *settings.Store
	// Device holds the telemetry row and the pending relay command. The readings
	// ingest hands the command over through Device.TakeRelayCommand.
	Device *device.Store
	// Alerts opens and re-announces alerts for stored readings (readings ingest and
	// live sampling call Evaluate), pushing through notifications to every device.
	Alerts *alerts.Service
	// Audit records operator changes: settings, relay commands, accounts.
	Audit *audit.Log
}

// New opens the database and returns the API.
func New(cfg config.Config) (http.Handler, error) {
	conn, err := db.Open(cfg.DatabaseURL, cfg.DatabaseToken)
	if err != nil {
		return nil, httpx.Config(err)
	}
	return Routes(NewDeps(cfg, conn)), nil
}

// NewDeps builds the shared dependencies over an open database.
func NewDeps(cfg config.Config, conn *sql.DB) Deps {
	return Deps{
		Config:   cfg,
		DB:       conn,
		Guard:    auth.NewGuard(cfg.JWTSecret, cfg.DeviceAPIKey),
		Users:    users.NewStore(conn),
		Settings: settings.NewStore(conn),
		Device:   device.NewStore(conn),
		Alerts:   newAlerts(conn, defaultPush()),
		Audit:    audit.NewLog(conn),
	}
}

// Routes builds the handler for every route group.
//
// To add a group: give its package a Handler with Register(*http.ServeMux), construct
// it here from d, and register it. Patterns are "METHOD /api/v1/..." (use
// httpx.APIPrefix).
func Routes(d Deps) http.Handler {
	mux := http.NewServeMux()
	mux.HandleFunc("GET "+httpx.APIPrefix+"/health", health)

	account.NewHandler(d.DB, d.Users, d.Guard, d.Audit).Register(mux)
	users.NewHandler(d.Users, d.Guard, d.Audit).Register(mux)
	settings.NewHandler(d.Settings, d.Guard, d.Audit).Register(mux)
	device.NewHandler(d.Device, d.Settings, d.Guard, d.Audit).Register(mux)
	readings.NewHandler(readings.Deps{
		Store:            readings.NewStore(d.DB),
		Settings:         d.Settings,
		Relay:            d.Device,
		Alerts:           d.Alerts,
		Guard:            d.Guard,
		SampleIntervalMS: d.Config.SampleIntervalMS,
	}).Register(mux)
	alerts.NewHandler(alerts.NewStore(d.DB), d.Guard).Register(mux)
	notifications.NewHandler(notifications.NewStore(d.DB), d.Guard).Register(mux)
	audit.NewHandler(audit.NewStore(d.DB), d.Guard).Register(mux)
	insights.NewHandler(d.DB, d.Settings, d.Guard).Register(mux)

	return httpx.CORS(httpx.Log(httpx.Bare(mux)))
}

type healthResponse struct {
	Status         string    `json:"status"`
	CheckedAt      wire.Time `json:"checkedAt"`
	CheckedAtLabel string    `json:"checkedAtLabel"`
}

// health: GET /api/v1/health. Public and touches no tables, so the app can probe
// reachability before sign-in at no cost.
func health(w http.ResponseWriter, _ *http.Request) {
	now := time.Now().UTC()
	httpx.WriteJSON(w, http.StatusOK, healthResponse{
		Status:         "ok",
		CheckedAt:      wire.Time{Time: now},
		CheckedAtLabel: wire.LocalLabel(now),
	})
}
