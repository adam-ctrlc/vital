package insights

import (
	"context"
	"database/sql"
	"fmt"
	"math"
	"net/http"
	"sync"
	"time"

	"github.com/adam-ctrlc/vital/api/internal/auth"
	"github.com/adam-ctrlc/vital/api/internal/httpx"
	"github.com/adam-ctrlc/vital/api/internal/settings"
	"github.com/adam-ctrlc/vital/api/internal/wire"
)

// samplesSQL is the one pass over the range: only the columns the analysis reads,
// ordered so each feed's readings are consecutive. Binds: ?1 start, ?2 end (stored
// format), ?3 source or null for both.
const samplesSQL = `select source, recorded_at, voltage_v, apparent_power_va, power_w, power_factor,
       frequency_hz, energy_kwh, temperature_c, status
from readings
where recorded_at >= ?1 and recorded_at < ?2 and (?3 is null or source = ?3)
order by source, recorded_at`

// alertsSQL is every alert raised in the range, newest first, with the name of whoever
// acknowledged it (composed the way users.FullName does). Binds: ?1 start, ?2 end.
const alertsSQL = `select a.id, a.kind, a.value, a.threshold, a.created_at, a.acknowledged_at, a.response_ms,
       a.acknowledged_by, u.first_name || ' ' || coalesce(u.middle_name || ' ', '') || u.last_name
from alerts a left join users u on u.id = a.acknowledged_by
where a.created_at >= ?1 and a.created_at < ?2
order by a.created_at desc, a.id desc`

// Handler serves /api/v1/insights and /api/v1/readings/export. Both are admin only.
type Handler struct {
	db       *sql.DB
	settings *settings.Store
	guard    *auth.Guard
	now      func() time.Time
}

// NewHandler returns the routes.
func NewHandler(conn *sql.DB, st *settings.Store, guard *auth.Guard) *Handler {
	return &Handler{db: conn, settings: st, guard: guard, now: time.Now}
}

// Register mounts the routes on mux.
func (h *Handler) Register(mux *http.ServeMux) {
	mux.Handle("GET "+httpx.APIPrefix+"/insights", h.guard.Admin(httpx.HandlerFunc(h.insights)))
	mux.Handle("GET "+httpx.APIPrefix+"/readings/export", h.guard.Admin(httpx.HandlerFunc(h.export)))
}

// insights: GET /insights?from=YYYY-MM-DD&to=YYYY-MM-DD&source=hardware|simulator|all
func (h *Handler) insights(w http.ResponseWriter, r *http.Request) error {
	rng, err := parseRange(httpx.NewQuery(r), h.now())
	if err != nil {
		return err
	}
	ctx := r.Context()

	// Three independent reads, each its own HTTP round trip to the database, so they
	// run side by side rather than one after another.
	var (
		wg      sync.WaitGroup
		st      settings.Settings
		samples []sample
		alerts  []alert
		errs    [3]error
	)
	wg.Add(3)
	go func() { defer wg.Done(); st, errs[0] = h.settings.Load(ctx) }()
	go func() { defer wg.Done(); samples, errs[1] = loadSamples(ctx, h.db, rng) }()
	go func() { defer wg.Done(); alerts, errs[2] = loadAlerts(ctx, h.db, rng) }()
	wg.Wait()
	for _, err := range errs {
		if err != nil {
			return err
		}
	}

	httpx.WriteJSON(w, http.StatusOK, compute(input{
		rng:        rng,
		ratePerKwh: float64(st.EnergyRatePerKwh),
		nominalV:   float64(st.NominalVoltageV),
		samples:    samples,
		alerts:     alerts,
	}))
	return nil
}

func storage(t time.Time) string { return wire.FormatStorage(t) }

func loadSamples(ctx context.Context, conn *sql.DB, rng Range) ([]sample, error) {
	rows, err := conn.QueryContext(ctx, samplesSQL, storage(rng.Start()), storage(rng.End()), rng.sourceArg())
	if err != nil {
		return nil, fmt.Errorf("insights: readings: %w", err)
	}
	defer rows.Close()

	var out []sample
	for rows.Next() {
		var (
			s                                      sample
			at, status                             string
			volts, va, power, pf, freq, kwh, tempC sql.NullFloat64
		)
		if err := rows.Scan(&s.source, &at, &volts, &va, &power, &pf, &freq, &kwh, &tempC, &status); err != nil {
			return nil, fmt.Errorf("insights: readings: %w", err)
		}
		if s.at, err = wire.ParseTime(at); err != nil {
			return nil, httpx.Upstream("%v", err)
		}
		s.voltage, s.va, s.power, s.powerFactor = orNaN(volts), orNaN(va), orNaN(power), orNaN(pf)
		s.frequency, s.energy, s.tempC = orNaN(freq), orNaN(kwh), orNaN(tempC)
		s.overload = status == "overload"
		out = append(out, s)
	}
	if err := rows.Err(); err != nil {
		return nil, fmt.Errorf("insights: readings: %w", err)
	}
	return out, nil
}

func loadAlerts(ctx context.Context, conn *sql.DB, rng Range) ([]alert, error) {
	rows, err := conn.QueryContext(ctx, alertsSQL, storage(rng.Start()), storage(rng.End()))
	if err != nil {
		return nil, fmt.Errorf("insights: alerts: %w", err)
	}
	defer rows.Close()

	var out []alert
	for rows.Next() {
		var (
			a                 alert
			createdAt         string
			ackedAt, by, name sql.NullString
			responseMs        sql.NullInt64
		)
		if err := rows.Scan(&a.id, &a.kind, &a.value, &a.threshold, &createdAt, &ackedAt, &responseMs, &by, &name); err != nil {
			return nil, fmt.Errorf("insights: alerts: %w", err)
		}
		if a.createdAt, err = wire.ParseTime(createdAt); err != nil {
			return nil, httpx.Upstream("%v", err)
		}
		if ackedAt.Valid {
			t, err := wire.ParseTime(ackedAt.String)
			if err != nil {
				return nil, httpx.Upstream("%v", err)
			}
			a.acknowledgedAt = &t
		}
		if responseMs.Valid {
			a.responseMs = &responseMs.Int64
		}
		if by.Valid {
			a.ackedBy = &by.String
		}
		if name.Valid {
			a.ackedByName = &name.String
		}
		out = append(out, a)
	}
	if err := rows.Err(); err != nil {
		return nil, fmt.Errorf("insights: alerts: %w", err)
	}
	return out, nil
}

func orNaN(v sql.NullFloat64) float64 {
	if !v.Valid {
		return math.NaN()
	}
	return v.Float64
}
