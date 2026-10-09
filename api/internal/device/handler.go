package device

import (
	"errors"
	"log/slog"
	"net/http"
	"time"

	"github.com/adam-ctrlc/vital/api/internal/auth"
	"github.com/adam-ctrlc/vital/api/internal/httpx"
	"github.com/adam-ctrlc/vital/api/internal/settings"
)

// Handler serves /api/v1/device.
type Handler struct {
	store    *Store
	settings *settings.Store
	guard    *auth.Guard
}

// NewHandler returns the device routes.
func NewHandler(store *Store, settings *settings.Store, guard *auth.Guard) *Handler {
	return &Handler{store: store, settings: settings, guard: guard}
}

// Register mounts the routes on mux.
func (h *Handler) Register(mux *http.ServeMux) {
	const p = httpx.APIPrefix + "/device"
	mux.Handle("GET "+p+"/status", h.guard.Admin(httpx.HandlerFunc(h.status)))
	mux.Handle("POST "+p+"/heartbeat", h.guard.Device(httpx.HandlerFunc(h.heartbeat)))
	mux.Handle("POST "+p+"/relay", h.guard.Admin(httpx.HandlerFunc(h.relay)))
}

// status: GET /device/status. Admin only: the payload carries the board's SSID, LAN
// address, firmware and uptime, which is network reconnaissance rather than
// monitoring data. Only the Settings screen renders it, and that screen is already
// admin-gated. The dashboard learns whether the board is live from /readings/latest.
func (h *Handler) status(w http.ResponseWriter, r *http.Request) error {
	st, err := h.settings.Load(r.Context())
	if err != nil {
		return err
	}
	status, err := h.store.Status(r.Context(), st.SourceMode, time.Now())
	if errors.Is(err, ErrUnreadableTimestamp) {
		return httpx.Upstream("%v", err)
	}
	if err != nil {
		return err
	}
	httpx.WriteJSON(w, http.StatusOK, status)
	return nil
}

// heartbeat: POST /device/heartbeat. Device only: the firmware self-reports its
// identity and link telemetry, and gets the current thresholds and any pending relay
// command back.
func (h *Handler) heartbeat(w http.ResponseWriter, r *http.Request) error {
	var hb Heartbeat
	if err := httpx.DecodeJSON(r, &hb); err != nil {
		return err
	}

	// Loaded before the handover, not after it. For firmware that does not acknowledge,
	// RecordHeartbeat clears the command as it reads it, so anything that failed after
	// it would lose the command for good.
	st, err := h.settings.Load(r.Context())
	if err != nil {
		return err
	}

	pending, err := h.store.RecordHeartbeat(r.Context(), hb, time.Now())
	if err != nil {
		return err
	}

	httpx.WriteJSON(w, http.StatusOK, NewHeartbeatAck(st, pending))
	return nil
}

// relay: POST /device/relay. Admin only: asks the board to open or close the relay.
//
// A request rather than a command, because nothing here can reach the board: it sits
// on someone's Wi-Fi behind whatever NAT and only ever speaks outward. The command
// waits for its next reading or heartbeat.
//
// Restricted to admins deliberately. Closing means energizing a transformer that may
// still be faulted, and opening means cutting the load; both belong to whoever is
// responsible for the transformer rather than to anyone holding the app.
//
// Neither command defeats the protection. An overload re-opens the contacts three
// seconds later no matter who closed them.
func (h *Handler) relay(w http.ResponseWriter, r *http.Request) error {
	var req RelayRequest
	if err := httpx.DecodeJSON(r, &req); err != nil {
		return err
	}
	cmd, err := req.Validate()
	if err != nil {
		return httpx.BadRequest("%s", err.Error())
	}

	if err := h.store.RequestRelayCommand(r.Context(), cmd, time.Now()); err != nil {
		return err
	}

	admin, _ := auth.IdentityFrom(r.Context())
	slog.WarnContext(r.Context(), "relay command queued", "user_id", admin.ID.String(), "command", string(cmd))

	httpx.WriteJSON(w, http.StatusOK, Accepted{Accepted: true})
	return nil
}
