//go:build sqlite

package app

import (
	"context"
	"database/sql"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"path/filepath"
	"regexp"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/google/uuid"

	api "github.com/adam-ctrlc/vital/api"
	"github.com/adam-ctrlc/vital/api/internal/auth"
	"github.com/adam-ctrlc/vital/api/internal/config"
	"github.com/adam-ctrlc/vital/api/internal/db"
	"github.com/adam-ctrlc/vital/api/internal/device"
	"github.com/adam-ctrlc/vital/api/internal/wire"
)

const deviceKey = "dev-key"

// firmwareHeartbeat is the body BackendClient::postHeartbeat sends.
const firmwareHeartbeat = `{"deviceId":"vital-esp32-01","firmware":"1.0.0","ssid":"home","ipAddress":"192.168.1.20",` +
	`"signalDbm":-61,"uptimeSeconds":3600,"relayLockedOut":false}`

// ackFor is the exact heartbeat response with the seeded settings, for a command
// (JSON: null or a quoted word) handed over under id (JSON: null or a number).
func ackFor(command, id string) string {
	return `{"loadThresholdVa":900.0,"tripThresholdVa":980.0,"tempThresholdC":40.0,"relayCommand":` + command +
		`,"recloseDelaySeconds":30,"tripConfirmSeconds":3,"relayCommandId":` + id + `}`
}

// noCommand is ackFor with nothing pending.
var noCommand = ackFor("null", "null")

// deviceHarness is newHarness with the database and deps kept, so a test can seed
// readings and call the device store the way the readings ingest does. The busy
// timeout lets a second BEGIN IMMEDIATE wait its turn, as it does on Turso.
type deviceHarness struct {
	*harness
	conn *sql.DB
	deps Deps
	user string
}

func newDeviceHarness(t *testing.T) *deviceHarness {
	t.Helper()
	path := filepath.Join(t.TempDir(), "device.db")
	conn, err := db.Open("file:"+path+"?_pragma=busy_timeout(10000)", "")
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { conn.Close() })
	if _, err := db.ApplySchema(context.Background(), conn, api.Schema); err != nil {
		t.Fatal(err)
	}

	d := NewDeps(config.Config{JWTSecret: "test-secret", DeviceAPIKey: deviceKey}, conn)
	srv := httptest.NewServer(Routes(d))
	t.Cleanup(srv.Close)

	adminID := uuid.New()
	admin, _ := d.Guard.Issue(adminID, auth.Admin)
	user, _ := d.Guard.Issue(uuid.New(), auth.User)
	return &deviceHarness{
		harness: &harness{t: t, srv: srv, admin: admin, adminID: adminID},
		conn:    conn,
		deps:    d,
		user:    user,
	}
}

// heartbeat posts body as the board does, with the given device key ("" for none).
func (h *deviceHarness) heartbeat(key, body string) (int, string) {
	h.t.Helper()
	req, _ := http.NewRequest(http.MethodPost, h.srv.URL+"/api/v1/device/heartbeat", strings.NewReader(body))
	req.Header.Set("Content-Type", "application/json")
	if key != "" {
		req.Header.Set("x-device-key", key)
	}
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		h.t.Fatal(err)
	}
	defer resp.Body.Close()
	b, _ := io.ReadAll(resp.Body)
	return resp.StatusCode, string(b)
}

func (h *deviceHarness) expectHeartbeat(body string, wantStatus int, wantBody string) {
	h.t.Helper()
	status, got := h.heartbeat(deviceKey, body)
	if status != wantStatus || (wantBody != "" && got != wantBody) {
		h.t.Fatalf("heartbeat: %d %s\nwant %d %s", status, got, wantStatus, wantBody)
	}
}

func (h *deviceHarness) insertReading(relayClosed any, recordedAt string) {
	h.t.Helper()
	if _, err := h.conn.Exec(`insert into readings (relay_closed, status, source, recorded_at)
		values (?1, 'normal', 'hardware', ?2)`, relayClosed, recordedAt); err != nil {
		h.t.Fatal(err)
	}
}

func TestDeviceAccess(t *testing.T) {
	h := newDeviceHarness(t)
	const unauthorized = `{"error":"Missing or invalid token"}`

	for _, key := range []string{"", "wrong-key", "DEV-KEY"} {
		if status, body := h.heartbeat(key, firmwareHeartbeat); status != 401 || body != unauthorized {
			t.Errorf("heartbeat with key %q: %d %s", key, status, body)
		}
	}
	// A bearer token is not a device key, even an admin's.
	h.expect("POST", "/api/v1/device/heartbeat", h.admin, firmwareHeartbeat, 401, unauthorized)

	h.expect("GET", "/api/v1/device/status", "", "", 401, unauthorized)
	h.expect("GET", "/api/v1/device/status", h.user, "", 403, `{"error":"Admin access required"}`)
	h.expect("POST", "/api/v1/device/relay", "", `{"command":"open"}`, 401, unauthorized)
	h.expect("POST", "/api/v1/device/relay", h.user, `{"command":"open"}`, 403, `{"error":"Admin access required"}`)
	// The guard runs before the body is read: a bad body from a non-admin is still a 403.
	h.expect("POST", "/api/v1/device/relay", h.user, `{`, 403, "")
}

func TestDeviceHeartbeat(t *testing.T) {
	h := newDeviceHarness(t)

	// The fields the firmware parses, exactly as the Rust API wrote them.
	h.expectHeartbeat(firmwareHeartbeat, 200, noCommand)

	// Request-shape rejections, as axum gave them.
	h.expectHeartbeat(`{"signalDbm":"strong"}`, 422, "")
	h.expectHeartbeat(`null`, 422, "")
	h.expectHeartbeat(`{"deviceId":`, 400, "")

	// The ack follows an operator's edit, which is how it reaches an offline board.
	h.expect("PUT", "/api/v1/settings", h.admin,
		`{"loadThresholdVa":850.5,"tripThresholdVa":950,"tempThresholdC":45,"recloseDelaySeconds":60,"tripConfirmSeconds":5}`, 200, "")
	h.expectHeartbeat(`{}`, 200, `{"loadThresholdVa":850.5,"tripThresholdVa":950.0,"tempThresholdC":45.0,`+
		`"relayCommand":null,"recloseDelaySeconds":60,"tripConfirmSeconds":5,"relayCommandId":null}`)
}

func TestDeviceRelayValidation(t *testing.T) {
	h := newDeviceHarness(t)

	for _, body := range []string{`{"command":"Open"}`, `{"command":"toggle"}`, `{"command":""}`} {
		h.expect("POST", "/api/v1/device/relay", h.admin, body, 400, `{"error":"Relay command must be open or close"}`)
	}
	for _, body := range []string{`{}`, `{"command":null}`, `{"command":1}`, `null`} {
		h.expect("POST", "/api/v1/device/relay", h.admin, body, 422, "")
	}
	h.expect("POST", "/api/v1/device/relay", h.admin, `{"command":`, 400, "")

	// Nothing was queued by any of that.
	h.expectHeartbeat(`{}`, 200, noCommand)
}

func TestDeviceRelayHandedOverExactlyOnce(t *testing.T) {
	h := newDeviceHarness(t)

	h.expect("POST", "/api/v1/device/relay", h.admin, `{"command":"open"}`, 200, `{"accepted":true}`)
	h.expectHeartbeat(firmwareHeartbeat, 200, ackFor(`"open"`, "1"))
	h.expectHeartbeat(firmwareHeartbeat, 200, noCommand)

	// A later press replaces a pending one rather than queueing behind it.
	h.expect("POST", "/api/v1/device/relay", h.admin, `{"command":"open"}`, 200, `{"accepted":true}`)
	h.expect("POST", "/api/v1/device/relay", h.admin, `{"command":"close"}`, 200, `{"accepted":true}`)
	h.expectHeartbeat(`{}`, 200, ackFor(`"close"`, "3"))
	h.expectHeartbeat(`{}`, 200, noCommand)

	// Taken by the reading ingest first, the heartbeat no longer sees it.
	h.expect("POST", "/api/v1/device/relay", h.admin, `{"command":"close"}`, 200, `{"accepted":true}`)
	got, err := h.deps.Device.RelayHandover(context.Background(), nil, time.Now())
	if err != nil || got != (device.Pending{Command: device.CommandClose, ID: 4}) {
		t.Fatalf("ingest handover = %+v, %v; want close 4", got, err)
	}
	h.expectHeartbeat(`{}`, 200, noCommand)
}

// TestDeviceRelayAcknowledged is firmware that acknowledges: the command comes back
// on every request, heartbeat or reading, until the board says it applied it.
func TestDeviceRelayAcknowledged(t *testing.T) {
	h := newDeviceHarness(t)
	ctx := context.Background()

	h.expect("POST", "/api/v1/device/relay", h.admin, `{"command":"open"}`, 200, `{"accepted":true}`)
	h.expectHeartbeat(`{"relayCommandAck":0}`, 200, ackFor(`"open"`, "1"))
	h.expectHeartbeat(`{"relayCommandAck":0}`, 200, ackFor(`"open"`, "1"))
	ack := int64(0)
	if got, err := h.deps.Device.RelayHandover(ctx, &ack, time.Now()); err != nil || got != (device.Pending{Command: device.CommandOpen, ID: 1}) {
		t.Fatalf("ingest before the ack = %+v, %v; want open 1", got, err)
	}

	h.expectHeartbeat(`{"relayCommandAck":1}`, 200, noCommand)
	ack = 1
	if got, err := h.deps.Device.RelayHandover(ctx, &ack, time.Now()); err != nil || got != (device.Pending{}) {
		t.Fatalf("ingest after the ack = %+v, %v; want nothing", got, err)
	}
}

// TestDeviceRelayConcurrentHeartbeats: heartbeats arriving together over HTTP share
// one pending command between them, and none is turned into an error.
func TestDeviceRelayConcurrentHeartbeats(t *testing.T) {
	h := newDeviceHarness(t)
	h.expect("POST", "/api/v1/device/relay", h.admin, `{"command":"open"}`, 200, `{"accepted":true}`)

	const requests = 12
	var (
		wg     sync.WaitGroup
		mu     sync.Mutex
		opened int
		bad    []string
	)
	for range requests {
		wg.Go(func() {
			status, body := h.heartbeat(deviceKey, firmwareHeartbeat)
			mu.Lock()
			defer mu.Unlock()
			switch {
			case status != 200:
				bad = append(bad, body)
			case body == ackFor(`"open"`, "1"):
				opened++
			case body != noCommand:
				bad = append(bad, body)
			}
		})
	}
	wg.Wait()

	if len(bad) > 0 || opened != 1 {
		t.Fatalf("command handed over %d times; unexpected responses: %v", opened, bad)
	}
}

func TestDeviceStatus(t *testing.T) {
	h := newDeviceHarness(t)

	// Nothing reported yet: every key present, null.
	h.expect("GET", "/api/v1/device/status", h.admin, "", 200,
		`{"connected":false,"relayLockedOut":false,"relayClosed":null,"deviceId":null,"firmware":null,`+
			`"ipAddress":null,"signalDbm":null,"uptimeSeconds":null,"ssid":null,"lastSeenAt":null,`+
			`"lastSeenLabel":null,"simulated":false,"resetReason":null}`)

	// A heartbeat fills the identity; a fresh hardware reading makes it live.
	h.expectHeartbeat(strings.Replace(firmwareHeartbeat, `"relayLockedOut":false`, `"relayLockedOut":true,"resetReason":"brownout"`, 1), 200, "")
	fresh := time.Now().Add(-2 * time.Second)
	h.insertReading(1, wire.FormatStorage(fresh))

	got := h.expect("GET", "/api/v1/device/status", h.admin, "", 200, "")
	want := `^\{"connected":true,"relayLockedOut":true,"relayClosed":true,"deviceId":"vital-esp32-01","firmware":"1.0.0",` +
		`"ipAddress":"192.168.1.20","signalDbm":-61,"uptimeSeconds":3600,"ssid":"home",` +
		`"lastSeenAt":"` + regexp.QuoteMeta(wire.FormatTime(fresh.Truncate(time.Millisecond))) + `",` +
		`"lastSeenLabel":"[A-Z][a-z]+ \d{1,2}, \d{4} \d{1,2}:\d\d [AP]M","simulated":false,"resetReason":"brownout"\}$`
	if !regexp.MustCompile(want).MatchString(got) {
		t.Errorf("live status = %s", got)
	}

	// Simulation mode is flagged.
	h.expect("PUT", "/api/v1/settings/source", h.admin, `{"sourceMode":"simulation"}`, 200, "")
	if got := h.expect("GET", "/api/v1/device/status", h.admin, "", 200, ""); !strings.HasSuffix(got, `"simulated":true,"resetReason":"brownout"}`) {
		t.Errorf("simulation status = %s", got)
	}
}

func TestDeviceStatusStaleReading(t *testing.T) {
	h := newDeviceHarness(t)
	h.insertReading(1, wire.FormatStorage(time.Now().Add(-time.Hour)))

	var status map[string]any
	if err := json.Unmarshal([]byte(h.expect("GET", "/api/v1/device/status", h.admin, "", 200, "")), &status); err != nil {
		t.Fatal(err)
	}
	// The position expires with the link; last seen does not.
	if status["connected"] != false || status["relayClosed"] != nil || status["lastSeenAt"] == nil || status["lastSeenLabel"] == nil {
		t.Errorf("stale status = %v", status)
	}
}

func TestDeviceStatusUnreadableTimestamp(t *testing.T) {
	h := newDeviceHarness(t)
	h.insertReading(1, "not a time")

	got := h.expect("GET", "/api/v1/device/status", h.admin, "", 502, "")
	if !strings.HasPrefix(got, `{"error":"Upstream error: unreadable timestamp`) {
		t.Errorf("unreadable timestamp = %s", got)
	}
}
