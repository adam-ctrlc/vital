package readings

import (
	"context"
	"log/slog"
	"net/http"
	"time"

	"github.com/adam-ctrlc/vital/api/internal/alerts"
	"github.com/adam-ctrlc/vital/api/internal/auth"
	"github.com/adam-ctrlc/vital/api/internal/device"
	"github.com/adam-ctrlc/vital/api/internal/httpx"
	"github.com/adam-ctrlc/vital/api/internal/settings"
)

// AlertEvaluator opens or re-announces alerts for a stored reading. *alerts.Service
// satisfies it.
type AlertEvaluator interface {
	Evaluate(ctx context.Context, m alerts.Measurement, t alerts.Thresholds) error
}

// SettingsLoader reads the operator thresholds. *settings.Store satisfies it.
type SettingsLoader interface {
	Load(ctx context.Context) (settings.Settings, error)
}

// RelayCommands hands over a queued relay command, acknowledged by ack (nil for
// firmware that does not acknowledge). *device.Store satisfies it.
type RelayCommands interface {
	RelayHandover(ctx context.Context, ack *int64, now time.Time) (device.Pending, error)
}

// Deps is what the readings routes are built from.
type Deps struct {
	Store    *Store
	Settings SettingsLoader
	Relay    RelayCommands
	// Alerts evaluates every stored reading; app passes the alerts.Service. Nil
	// skips evaluation, for tests only.
	Alerts AlertEvaluator
	Guard  *auth.Guard
	// SampleIntervalMS is how often the simulator persists a sample (SAMPLE_INTERVAL_MS).
	SampleIntervalMS int64
	// Log receives ingest diagnostics. Nil uses slog.Default().
	Log *slog.Logger
	// Now is the clock. Nil uses time.Now; tests pin it.
	Now func() time.Time
}

// Handler serves /api/v1/readings.
type Handler struct {
	d Deps
}

// NewHandler returns the readings routes.
func NewHandler(d Deps) *Handler {
	if d.Log == nil {
		d.Log = slog.Default()
	}
	if d.Now == nil {
		d.Now = time.Now
	}
	return &Handler{d: d}
}

// Register mounts the routes on mux.
func (h *Handler) Register(mux *http.ServeMux) {
	const p = httpx.APIPrefix + "/readings"
	g := h.d.Guard
	mux.Handle("GET "+p+"/latest", g.User(httpx.HandlerFunc(h.latest)))
	mux.Handle("GET "+p, g.Admin(httpx.HandlerFunc(h.history)))
	mux.Handle("POST "+p, g.Device(httpx.HandlerFunc(h.ingest)))
	mux.Handle("GET "+p+"/trend", g.Admin(httpx.HandlerFunc(h.trend)))
}

// latest is the dashboard heartbeat: GET /readings/latest. Poll as fast as you like.
//
// In simulation mode the value is derived from the clock, and a sample is persisted
// only when the newest simulator row is older than the sample interval, so fast
// polling does not flood the database. In hardware mode nothing is simulated or
// recorded: the newest pushed reading is served while it is inside the connected
// window, and nothing at all once it is not.
func (h *Handler) latest(w http.ResponseWriter, r *http.Request) error {
	ctx := r.Context()
	state, err := h.d.Store.liveState(ctx)
	if err != nil {
		return err
	}
	now := h.d.Now().UTC()

	var latestHardware *Reading
	if state.settings.SourceMode == sourceModeHardware {
		if latestHardware, err = h.d.Store.LatestHardware(ctx); err != nil {
			return err
		}
	}
	f := resolveFeed(state.settings.SourceMode, latestHardware, now)

	// The cheap check first, off the state already loaded: most polls are not due
	// and should not pay a second round trip. recordSampleSQL decides for real.
	if f.simulated && isSampleDue(state.latestSimulatorMs, h.d.SampleIntervalMS, now) {
		sample, err := h.d.Store.RecordSample(ctx, f.input, h.d.SampleIntervalMS, limitsOf(state.settings))
		if err != nil {
			return err
		}
		// Only the request that wrote the row evaluates alerts, so one condition
		// still raises one alert and one push.
		if sample != nil {
			if err := h.evaluateAlerts(ctx, *sample, state.settings); err != nil {
				return err
			}
		}
	}

	httpx.WriteJSON(w, http.StatusOK, newLiveReading(f, state.settings, state.deviceIP))
	return nil
}

// ingest is hardware ingest: POST /readings, authenticated by x-device-key.
func (h *Handler) ingest(w http.ResponseWriter, r *http.Request) error {
	ctx := r.Context()
	var body ingestBody
	if err := httpx.DecodeJSON(r, &body); err != nil {
		return err
	}
	in := body.Input
	// Refused before any database round trip.
	if err := ValidateIngest(in); err != nil {
		return err
	}
	st, err := h.d.Settings.Load(ctx)
	if err != nil {
		return err
	}
	reading, err := h.record(ctx, in, "hardware", st)
	if err != nil {
		return err
	}

	// Taken only after the reading is safely recorded: for firmware that does not
	// acknowledge, the command is cleared as it is read, so one handed to a request
	// that then failed would be lost for good. Best effort: the reading is why the
	// board called, the command is a passenger, and failing the call over it would
	// make the board treat a stored reading as lost.
	pending, err := h.d.Relay.RelayHandover(ctx, body.RelayCommandAck, h.d.Now())
	if err != nil {
		h.d.Log.WarnContext(ctx, "could not read the pending relay command", "error", err)
		pending = device.Pending{}
	}

	httpx.WriteJSON(w, http.StatusOK, IngestAck{Reading: reading, RelayCommand: pending.Command, RelayCommandID: pending.IDOrNil()})
	return nil
}

// record stores a measurement and opens any alerts it triggers.
func (h *Handler) record(ctx context.Context, in Input, source string, st settings.Settings) (Reading, error) {
	// Guarded here as well as at the route, so every path that stores a reading is
	// covered by one rule.
	if in.IsEmpty() {
		return Reading{}, errEmptyReading()
	}
	limits := limitsOf(st)
	load := limits.LoadVA
	apparent, status := Evaluate(in, load)

	// Loud only when worth reading: an overload, or a reading with no load in it, at
	// info; the ordinary reading under the limit at debug.
	if status == StatusOverload || apparent == nil {
		h.d.Log.InfoContext(ctx, "reading evaluated", "source", source,
			"voltage_v", in.VoltageV, "current_a", in.CurrentA, "apparent_power_va", apparent,
			"alarm_at", load, "status", status)
	} else {
		h.d.Log.DebugContext(ctx, "reading evaluated", "source", source, "apparent_power_va", *apparent)
	}

	reading, err := h.d.Store.Insert(ctx, in, apparent, status, source, limits)
	if err != nil {
		return Reading{}, err
	}
	if err := h.evaluateAlerts(ctx, reading, st); err != nil {
		return Reading{}, err
	}
	return reading, nil
}

// evaluateAlerts hands a stored reading to alert evaluation. A failure fails the
// request, as the Rust API's ? did; the reading is already stored by then.
func (h *Handler) evaluateAlerts(ctx context.Context, r Reading, st settings.Settings) error {
	if h.d.Alerts == nil {
		return nil
	}
	return h.d.Alerts.Evaluate(ctx,
		alerts.Measurement{ReadingID: r.ID, ApparentPowerVA: unwire(r.ApparentPowerVA), TemperatureC: unwire(r.TemperatureC)},
		alerts.Thresholds{LoadVA: float64(st.LoadThresholdVA), TempC: float64(st.TempThresholdC)})
}

// history is the reading log: GET /readings, admin only.
func (h *Handler) history(w http.ResponseWriter, r *http.Request) error {
	q, err := historyQueryFrom(r)
	if err != nil {
		return err
	}
	f, err := q.Resolve()
	if err != nil {
		return err
	}
	rows, total, err := h.d.Store.History(r.Context(), f)
	if err != nil {
		return err
	}
	httpx.WriteJSON(w, http.StatusOK, httpx.NewPage(rows, total, f.Limit, f.Offset))
	return nil
}

// historyQueryFrom decodes the log's query string.
func historyQueryFrom(r *http.Request) (HistoryQuery, error) {
	q := httpx.NewQuery(r)
	hq := HistoryQuery{
		Status:   q.String("status"),
		Source:   q.String("source"),
		Q:        q.String("q"),
		From:     q.String("from"),
		To:       q.String("to"),
		MinVA:    q.Float64("minVa"),
		MaxVA:    q.Float64("maxVa"),
		MinTempC: q.Float64("minTempC"),
		Sort:     q.String("sort"),
		Limit:    q.Int64("limit"),
		Offset:   q.Int64("offset"),
	}
	return hq, q.Err()
}

// trend is the daily aggregate: GET /readings/trend?days=N, admin only.
func (h *Handler) trend(w http.ResponseWriter, r *http.Request) error {
	q := httpx.NewQuery(r)
	days := q.Int64("days")
	if err := q.Err(); err != nil {
		return err
	}
	points, err := h.d.Store.Trend(r.Context(), trendDays(days))
	if err != nil {
		return err
	}
	httpx.WriteJSON(w, http.StatusOK, points)
	return nil
}
