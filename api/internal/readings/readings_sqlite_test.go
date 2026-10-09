//go:build sqlite

// End-to-end tests of the readings routes against a throwaway SQLite file built from
// schema.sql. Run with:
//
//	go test -tags sqlite ./internal/readings/
package readings

import (
	"context"
	"encoding/json"
	"errors"
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
	"github.com/adam-ctrlc/vital/api/internal/alerts"
	"github.com/adam-ctrlc/vital/api/internal/auth"
	"github.com/adam-ctrlc/vital/api/internal/db"
	"github.com/adam-ctrlc/vital/api/internal/device"
	"github.com/adam-ctrlc/vital/api/internal/settings"
	"github.com/adam-ctrlc/vital/api/internal/wire"
)

const deviceKey = "dev-key"

// recordedAlerts stands in for the alerts service and remembers what it was asked.
type recordedAlerts struct {
	mu    sync.Mutex
	calls []alerts.Measurement
	limit []alerts.Thresholds
	err   error
}

func (a *recordedAlerts) Evaluate(_ context.Context, m alerts.Measurement, t alerts.Thresholds) error {
	a.mu.Lock()
	defer a.mu.Unlock()
	a.calls = append(a.calls, m)
	a.limit = append(a.limit, t)
	return a.err
}

// brokenRelay fails every handover, to prove the command is only a passenger.
type brokenRelay struct{}

func (brokenRelay) RelayHandover(context.Context, *int64, time.Time) (device.Pending, error) {
	return device.Pending{}, errors.New("stream not found")
}

type harness struct {
	t      *testing.T
	srv    *httptest.Server
	alerts *recordedAlerts
	admin  string
	user   string
	exec   func(query string, args ...any)
	count  func(query string, args ...any) int64
}

type options struct {
	now   func() time.Time
	relay RelayCommands
}

func newHarness(t *testing.T, opts options) *harness {
	t.Helper()
	conn, err := db.Open("file:"+filepath.Join(t.TempDir(), "test.db"), "")
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { conn.Close() })
	if _, err := db.ApplySchema(context.Background(), conn, api.Schema); err != nil {
		t.Fatal(err)
	}

	guard := auth.NewGuard("test-secret", deviceKey)
	rec := &recordedAlerts{}
	relay := opts.relay
	if relay == nil {
		relay = device.NewStore(conn)
	}
	mux := http.NewServeMux()
	NewHandler(Deps{
		Store:            NewStore(conn),
		Settings:         settings.NewStore(conn),
		Relay:            relay,
		Alerts:           rec,
		Guard:            guard,
		SampleIntervalMS: 15_000,
		Now:              opts.now,
	}).Register(mux)
	srv := httptest.NewServer(mux)
	t.Cleanup(srv.Close)

	admin, _ := guard.Issue(uuid.New(), auth.Admin)
	user, _ := guard.Issue(uuid.New(), auth.User)
	h := &harness{t: t, srv: srv, alerts: rec, admin: admin, user: user}
	h.exec = func(query string, args ...any) {
		t.Helper()
		if _, err := conn.Exec(query, args...); err != nil {
			t.Fatalf("%s: %v", query, err)
		}
	}
	h.count = func(query string, args ...any) int64 {
		t.Helper()
		var n int64
		if err := conn.QueryRow(query, args...).Scan(&n); err != nil {
			t.Fatalf("%s: %v", query, err)
		}
		return n
	}
	return h
}

// request sends a request; auth is a bearer token, or "device:<key>" for x-device-key.
func (h *harness) request(method, path, auth, body string) (int, string) {
	h.t.Helper()
	var rd io.Reader
	if body != "" {
		rd = strings.NewReader(body)
	}
	req, _ := http.NewRequest(method, h.srv.URL+path, rd)
	if body != "" {
		req.Header.Set("Content-Type", "application/json")
	}
	if key, ok := strings.CutPrefix(auth, "device:"); ok {
		req.Header.Set("x-device-key", key)
	} else if auth != "" {
		req.Header.Set("Authorization", "Bearer "+auth)
	}
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		h.t.Fatal(err)
	}
	defer resp.Body.Close()
	b, _ := io.ReadAll(resp.Body)
	return resp.StatusCode, string(b)
}

func (h *harness) expect(method, path, auth, body string, wantStatus int, wantBody string) string {
	h.t.Helper()
	status, got := h.request(method, path, auth, body)
	if status != wantStatus {
		h.t.Fatalf("%s %s: status %d, want %d; body %s", method, path, status, wantStatus, got)
	}
	if wantBody != "" && got != wantBody {
		h.t.Fatalf("%s %s: body\n got %s\nwant %s", method, path, got, wantBody)
	}
	return got
}

// seed inserts a reading with an explicit recorded_at.
func (h *harness) seed(source, status string, va, tempC *float64, at time.Time) {
	h.t.Helper()
	h.exec(`insert into readings (apparent_power_va, temperature_c, status, source, recorded_at)
		values (?1, ?2, ?3, ?4, ?5)`, nullable(va), nullable(tempC), status, source, wire.FormatStorage(at))
}

// asDevice authenticates a request as the board.
const asDevice = "device:" + deviceKey

// recordedAtPattern matches a stored recorded_at as serialised.
const recordedAtPattern = `"recordedAt":"\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(\.\d{3})?Z"`

func TestIngest(t *testing.T) {
	h := newHarness(t, options{})
	const p = "/api/v1/readings"

	h.expect("POST", p, "", `{"voltageV":230}`, 401, `{"error":"Missing or invalid token"}`)
	h.expect("POST", p, "device:wrong", `{"voltageV":230}`, 401, `{"error":"Missing or invalid token"}`)
	h.expect("POST", p, h.admin, `{"voltageV":230}`, 401, "") // a person is not the board
	h.expect("POST", p, asDevice, `{}`, 400, `{"error":"At least one measurement is required"}`)
	h.expect("POST", p, asDevice, `{"relayClosed":true}`, 400, `{"error":"At least one measurement is required"}`)
	h.expect("POST", p, asDevice, `{"voltageV":1e200,"currentA":1e200}`, 400, `{"error":"Voltage must be between 0 and 1000"}`)
	h.expect("POST", p, asDevice, `{"powerFactor":1.5}`, 400, `{"error":"Power factor must be between 0 and 1"}`)
	h.expect("POST", p, asDevice, `{"voltageV":"high"}`, 422, "")
	h.expect("POST", p, asDevice, `not json`, 400, "")
	if n := h.count(`select count(*) from readings`); n != 0 {
		t.Fatalf("rejected ingests stored %d rows", n)
	}

	// An overload under load, with the relay closed.
	got := h.expect("POST", p, asDevice, `{"voltageV":230,"currentA":4,"temperatureC":41,"relayClosed":true}`, 200, "")
	re := regexp.MustCompile(`^\{"id":1,"voltageV":230\.0,"currentA":4\.0,"temperatureC":41\.0,"apparentPowerVa":920\.0,"status":"overload","source":"hardware","powerW":null,"powerFactor":null,"frequencyHz":null,"energyKwh":null,"relayClosed":true,"loadThresholdVa":900\.0,"tripThresholdVa":980\.0,"tempThresholdC":40\.0,` + recordedAtPattern + `,"relayCommand":null,"relayCommandId":null\}$`)
	if !re.MatchString(got) {
		t.Fatalf("ack = %s", got)
	}
	if len(h.alerts.calls) != 1 {
		t.Fatalf("alerts evaluated %d times, want 1", len(h.alerts.calls))
	}
	m, lim := h.alerts.calls[0], h.alerts.limit[0]
	if m.ReadingID != 1 || *m.ApparentPowerVA != 920 || *m.TemperatureC != 41 || lim.LoadVA != 900 || lim.TempC != 40 {
		t.Fatalf("alerts got %+v against %+v", m, lim)
	}

	// A probe-only board still reports; nothing to judge, so normal.
	got = h.expect("POST", p, asDevice, `{"temperatureC":31.5}`, 200, "")
	if !strings.Contains(got, `"apparentPowerVa":null,"status":"normal"`) || !strings.Contains(got, `"relayClosed":null`) {
		t.Fatalf("probe-only ack = %s", got)
	}

	// Firmware that does not acknowledge gets a queued relay command exactly once.
	queueRelay(h, "open", time.Now())
	got = h.expect("POST", p, asDevice, `{"currentA":0}`, 200, "")
	if !strings.HasSuffix(got, `"relayCommand":"open","relayCommandId":1}`) {
		t.Fatalf("ack with command = %s", got)
	}
	got = h.expect("POST", p, asDevice, `{"currentA":0}`, 200, "")
	if !strings.HasSuffix(got, `"relayCommand":null,"relayCommandId":null}`) {
		t.Fatalf("command handed over twice: %s", got)
	}
	var stored struct {
		RelayClosed *bool `json:"relayClosed"`
	}
	_ = json.Unmarshal([]byte(got), &stored)
	if stored.RelayClosed != nil {
		t.Fatal("relayClosed invented")
	}

	// A failing alert evaluation fails the call, as the Rust ? did; the row stays.
	h.alerts.err = errors.New("boom")
	h.expect("POST", p, asDevice, `{"currentA":1}`, 500, `{"error":"Database error"}`)
	if n := h.count(`select count(*) from readings`); n != 5 {
		t.Fatalf("%d rows stored, want 5", n)
	}

	// Every row carries the limits it was judged against, so a later edit to the
	// settings does not rewrite what an old overload meant.
	if n := h.count(`select count(*) from readings
		where load_threshold_va = 900 and trip_threshold_va = 980 and temp_threshold_c = 40`); n != 5 {
		t.Fatalf("%d rows carry the limits, want 5", n)
	}
	h.alerts.err = nil
	h.exec(`update settings set load_threshold_va = 500, trip_threshold_va = 600 where id = 1`)
	got = h.expect("POST", p, asDevice, `{"voltageV":100,"currentA":5.5}`, 200, "")
	if !strings.Contains(got, `"status":"overload"`) ||
		!strings.Contains(got, `"loadThresholdVa":500.0,"tripThresholdVa":600.0,"tempThresholdC":40.0`) {
		t.Fatalf("ack under the new limits = %s", got)
	}
}

// queueRelay queues a command the way POST /device/relay does: the next id, stamped.
func queueRelay(h *harness, command string, at time.Time) {
	h.t.Helper()
	h.exec(`update device_telemetry set relay_command = ?1, relay_command_id = relay_command_id + 1,
		relay_command_at = ?2 where id = 1`, command, wire.FormatStorage(at))
}

func TestIngestAcknowledgedRelayCommand(t *testing.T) {
	h := newHarness(t, options{})
	const p = "/api/v1/readings"

	queueRelay(h, "close", time.Now())

	// Repeated, under the same id, until the board says it has applied it: the
	// response carrying it may never have arrived.
	for range 2 {
		got := h.expect("POST", p, asDevice, `{"currentA":0,"relayCommandAck":0}`, 200, "")
		if !strings.HasSuffix(got, `"relayCommand":"close","relayCommandId":1}`) {
			t.Fatalf("unacknowledged = %s", got)
		}
	}
	got := h.expect("POST", p, asDevice, `{"currentA":0,"relayCommandAck":1}`, 200, "")
	if !strings.HasSuffix(got, `"relayCommand":null,"relayCommandId":null}`) {
		t.Fatalf("after the ack = %s", got)
	}
	if n := h.count(`select count(*) from device_telemetry where relay_command is null`); n != 1 {
		t.Fatal("the acknowledged command was not cleared")
	}

	// Older than CommandLifetime: dropped rather than delivered, and cleared.
	queueRelay(h, "open", time.Now().Add(-device.CommandLifetime-time.Second))
	got = h.expect("POST", p, asDevice, `{"currentA":0,"relayCommandAck":1}`, 200, "")
	if !strings.HasSuffix(got, `"relayCommand":null,"relayCommandId":null}`) {
		t.Fatalf("stale command = %s", got)
	}
	if n := h.count(`select count(*) from device_telemetry where relay_command is null`); n != 1 {
		t.Fatal("the stale command was not cleared")
	}

	// The ack is not a measurement: alone, it is still an empty reading.
	h.expect("POST", p, asDevice, `{"relayCommandAck":1}`, 400, `{"error":"At least one measurement is required"}`)
	h.expect("POST", p, asDevice, `{"currentA":0,"relayCommandAck":"one"}`, 422, "")
}

func TestIngestRelayCommandIsBestEffort(t *testing.T) {
	h := newHarness(t, options{relay: brokenRelay{}})
	got := h.expect("POST", "/api/v1/readings", asDevice, `{"voltageV":230,"currentA":1}`, 200, "")
	if !strings.HasSuffix(got, `"relayCommand":null,"relayCommandId":null}`) {
		t.Fatalf("ack = %s", got)
	}
}

func TestLatestHardware(t *testing.T) {
	h := newHarness(t, options{})
	const p = "/api/v1/readings/latest"
	h.expect("GET", p, "", "", 401, `{"error":"Missing or invalid token"}`)
	h.exec(`update device_telemetry set ip_address = '192.168.1.40' where id = 1`)

	// Nothing reported yet: no data, not connected, no address.
	got := h.expect("GET", p, h.user, "", 200, "")
	for _, want := range []string{`"voltageV":null`, `"apparentPowerVa":null`, `"status":"normal"`, `"loadThresholdVa":900.0`,
		`"tripThresholdVa":980.0`, `"tempThresholdF":104.0`, `"loadPercent":null`, `"overTemperature":false`, `"headroomVa":null`,
		`"simulated":false,"connected":false,"relayClosed":null,"deviceIp":null}`} {
		if !strings.Contains(got, want) {
			t.Fatalf("empty live missing %s: %s", want, got)
		}
	}

	// A stale reading reads as no data too.
	h.seed("hardware", "overload", ptr(950.0), ptr(45.0), time.Now().Add(-time.Minute))
	got = h.expect("GET", p, h.user, "", 200, "")
	if !strings.Contains(got, `"apparentPowerVa":null`) || !strings.Contains(got, `"connected":false`) {
		t.Fatalf("stale live = %s", got)
	}

	// A fresh one is served, connected, with the board's address.
	h.expect("POST", "/api/v1/readings", asDevice, `{"voltageV":230,"currentA":4,"temperatureC":41,"powerW":800,"relayClosed":false}`, 200, "")
	got = h.expect("GET", p, h.user, "", 200, "")
	for _, want := range []string{`"voltageV":230.0`, `"temperatureF":105.8`, `"apparentPowerVa":920.0`, `"status":"overload"`,
		`"overTemperature":true`, `"powerW":800.0`, `"headroomVa":-20.0`,
		`"simulated":false,"connected":true,"relayClosed":false,"deviceIp":"192.168.1.40"}`} {
		if !strings.Contains(got, want) {
			t.Fatalf("live missing %s: %s", want, got)
		}
	}
	// Hardware mode never samples.
	if n := h.count(`select count(*) from readings where source = 'simulator'`); n != 0 {
		t.Fatalf("hardware mode wrote %d simulator rows", n)
	}
}

func TestLatestSimulation(t *testing.T) {
	// Pinned near the real clock: SQLite's own now still drives the sample guard.
	now := time.Now().UTC().Truncate(time.Second).Add(123 * time.Millisecond)
	h := newHarness(t, options{now: func() time.Time { return now }})
	h.exec(`update settings set source_mode = 'simulation' where id = 1`)
	h.exec(`update device_telemetry set ip_address = '192.168.1.40' where id = 1`)
	// A hardware row must not suppress sampling.
	h.seed("hardware", "normal", ptr(100.0), nil, time.Now())

	got := h.expect("GET", "/api/v1/readings/latest", h.user, "", 200, "")
	want := Simulate(now.UnixMilli())
	var live struct {
		VoltageV   float64 `json:"voltageV"`
		EnergyKwh  float64 `json:"energyKwh"`
		RecordedAt string  `json:"recordedAt"`
		Simulated  bool    `json:"simulated"`
		Connected  bool    `json:"connected"`
		DeviceIP   *string `json:"deviceIp"`
		Relay      *bool   `json:"relayClosed"`
	}
	if err := json.Unmarshal([]byte(got), &live); err != nil {
		t.Fatal(err)
	}
	if live.VoltageV != *want.VoltageV || live.EnergyKwh != *want.EnergyKwh || live.RecordedAt != wire.FormatTime(now) ||
		!live.Simulated || live.Connected || live.DeviceIP != nil || live.Relay != nil {
		t.Fatalf("simulated live = %s", got)
	}

	// Polled again and again: still one sample per interval, and alerts evaluated once.
	for range 5 {
		h.expect("GET", "/api/v1/readings/latest", h.user, "", 200, "")
	}
	if n := h.count(`select count(*) from readings where source = 'simulator'`); n != 1 {
		t.Fatalf("%d simulator rows, want 1", n)
	}
	if n := h.count(`select count(*) from readings where source = 'simulator' and voltage_v = ?1`, *want.VoltageV); n != 1 {
		t.Fatal("the stored sample is not the value served")
	}
	if len(h.alerts.calls) != 1 {
		t.Fatalf("alerts evaluated %d times, want 1", len(h.alerts.calls))
	}
	if n := h.count(`select count(*) from readings where source = 'simulator'
		and load_threshold_va = 900 and trip_threshold_va = 980 and temp_threshold_c = 40`); n != 1 {
		t.Fatal("the simulated sample was stored without its limits")
	}

	// Once the newest sample is an interval old, the next poll writes another.
	h.exec(`update readings set recorded_at = ?1 where source = 'simulator'`, wire.FormatStorage(time.Now().Add(-16*time.Second)))
	h.expect("GET", "/api/v1/readings/latest", h.user, "", 200, "")
	if n := h.count(`select count(*) from readings where source = 'simulator'`); n != 2 {
		t.Fatalf("%d simulator rows after the interval, want 2", n)
	}
}

func TestHistory(t *testing.T) {
	h := newHarness(t, options{})
	const p = "/api/v1/readings"
	base := time.Date(2026, 10, 8, 16, 0, 0, 0, time.UTC) // midnight 9 Oct in UTC+8
	h.seed("hardware", "normal", ptr(500.0), ptr(30.0), base.Add(1*time.Hour))
	h.seed("hardware", "overload", ptr(950.0), ptr(42.0), base.Add(2*time.Hour))
	h.seed("simulator", "normal", ptr(700.0), nil, base.Add(3*time.Hour))
	h.seed("simulator", "overload", nil, ptr(45.0), base.Add(4*time.Hour))
	h.seed("hardware", "normal", ptr(50.0), ptr(25.0), base.Add(-24*time.Hour))

	h.expect("GET", p, "", "", 401, "")
	h.expect("GET", p, h.user, "", 403, `{"error":"Admin access required"}`)

	// Rows from before the limits were kept say so with null, never a guess; a row
	// that has them carries them out.
	h.exec(`update readings set load_threshold_va = 500, trip_threshold_va = 900, temp_threshold_c = 70
		where apparent_power_va = 950`)
	got := h.expect("GET", p+"?sort=load&limit=2", h.admin, "", 200, "")
	if !strings.Contains(got, `"apparentPowerVa":950.0,"status":"overload"`) ||
		!strings.Contains(got, `"loadThresholdVa":500.0,"tripThresholdVa":900.0,"tempThresholdC":70.0`) ||
		!strings.Contains(got, `"loadThresholdVa":null,"tripThresholdVa":null,"tempThresholdC":null`) {
		t.Fatalf("history limits = %s", got)
	}

	type page struct {
		Rows []struct {
			ID     int64    `json:"id"`
			VA     *float64 `json:"apparentPowerVa"`
			Status string   `json:"status"`
		} `json:"rows"`
		Total  int64 `json:"total"`
		Limit  int64 `json:"limit"`
		Offset int64 `json:"offset"`
	}
	list := func(query string) (ids []int64, pg page) {
		t.Helper()
		body := h.expect("GET", p+query, h.admin, "", 200, "")
		if err := json.Unmarshal([]byte(body), &pg); err != nil {
			t.Fatalf("%s: %v", body, err)
		}
		for _, r := range pg.Rows {
			ids = append(ids, r.ID)
		}
		return ids, pg
	}
	check := func(query string, want ...int64) {
		t.Helper()
		ids, _ := list(query)
		if !equal(ids, want) {
			t.Errorf("%s: ids %v, want %v", query, ids, want)
		}
	}

	_, pg := list("")
	if pg.Total != 5 || pg.Limit != 20 || pg.Offset != 0 || len(pg.Rows) != 5 {
		t.Fatalf("default page = %+v", pg)
	}
	check("", 4, 3, 2, 1, 5)
	check("?sort=oldest", 5, 1, 2, 3, 4)
	check("?sort=load", 2, 3, 1, 5, 4)        // null load last
	check("?sort=temperature", 4, 2, 1, 5, 3) // null temperature last
	check("?status=overload", 4, 2)
	check("?status=%20overload%20&source=hardware", 2)
	check("?source=simulator", 4, 3)
	check("?q=OVERL", 4, 2)
	check("?q=950", 2)
	check("?q=2026-10-09%2002:", 2) // the local (UTC+8) label of 18:00Z
	check("?q=50%25")               // 50% is literal, matches nothing
	check("?q=_")
	check("?from=2026-10-09T00:00:00%2B08:00", 4, 3, 2, 1)
	check("?from=2026-10-09T01:00:00%2B08:00&to=2026-10-08T20:00:00Z", 3, 2, 1)
	check("?minVa=500&maxVa=950", 3, 2, 1)
	check("?minTempC=42", 4, 2)
	check("?q=&status=&sort=&from=", 4, 3, 2, 1, 5) // blank is absent

	ids, pg := list("?limit=2&offset=1")
	if !equal(ids, []int64{3, 2}) || pg.Total != 5 || pg.Limit != 2 || pg.Offset != 1 {
		t.Errorf("window = %v %+v", ids, pg)
	}
	_, pg = list("?limit=0&offset=-3")
	if pg.Limit != 1 || pg.Offset != 0 {
		t.Errorf("clamped window = %+v", pg)
	}
	_, pg = list("?status=normal&limit=1")
	if pg.Total != 3 || len(pg.Rows) != 1 {
		t.Errorf("total must count every match: %+v", pg)
	}
	ids, _ = list("?status=normal&offset=50")
	if ids != nil {
		t.Errorf("past the end = %v", ids)
	}
	h.expect("GET", p+"?status=normal&offset=50", h.admin, "", 200, `{"rows":[],"total":3,"limit":20,"offset":50}`)

	h.expect("GET", p+"?status=broken", h.admin, "", 400, `{"error":"Invalid status: broken"}`)
	h.expect("GET", p+"?source=phone", h.admin, "", 400, `{"error":"Invalid source: phone"}`)
	h.expect("GET", p+"?sort=id", h.admin, "", 400, `{"error":"Invalid sort: id"}`)
	h.expect("GET", p+"?from=yesterday", h.admin, "", 400, `{"error":"Invalid from: expected an RFC 3339 instant"}`)
	h.expect("GET", p+"?minVa=NaN", h.admin, "", 400, `{"error":"Invalid minVa"}`)
	h.expect("GET", p+"?minVa=900&maxVa=100", h.admin, "", 400, `{"error":"MinVa is above maxVa"}`)
	h.expect("GET", p+"?from=2026-10-09T00:00:00Z&to=2026-10-09T00:00:00Z", h.admin, "", 400, `{"error":"From is not before to"}`)
	h.expect("GET", p+"?minVa=abc", h.admin, "", 400, "Failed to deserialize query string: minVa: invalid float literal")
	h.expect("GET", p+"?limit=", h.admin, "", 400, "Failed to deserialize query string: limit: invalid digit found in string")
}

func TestTrend(t *testing.T) {
	h := newHarness(t, options{})
	const p = "/api/v1/readings/trend"
	now := time.Now().UTC()
	today := time.Date(now.Year(), now.Month(), now.Day(), 0, 0, 0, 0, time.UTC)
	yesterday := today.AddDate(0, 0, -1)
	// Readings inside the window, on two UTC days.
	h.seed("hardware", "normal", ptr(600.0), ptr(30.0), now.Add(-time.Second))
	h.seed("hardware", "overload", ptr(1000.0), nil, now.Add(-2*time.Second))
	h.seed("hardware", "normal", nil, nil, yesterday.Add(time.Hour))
	h.seed("hardware", "normal", nil, ptr(36.0), yesterday.Add(2*time.Hour))
	// Ten days back: outside the default week, inside a 30 day window.
	h.seed("hardware", "normal", ptr(100.0), ptr(20.0), today.AddDate(0, 0, -10).Add(time.Hour))

	h.expect("GET", p, h.user, "", 403, "")
	h.expect("GET", p+"?days=abc", h.admin, "", 400, "Failed to deserialize query string: days: invalid digit found in string")

	day := func(t time.Time) string { return wire.FormatTime(t) }
	// yesterday.Add(time.Hour) could fall before the 7 day cutoff only if run at a
	// day boundary seven days long; it cannot, so both days are present.
	want := `[{"day":"` + day(yesterday) + `","avgPowerVa":null,"maxPowerVa":null,"avgTemperatureC":36.0,"samples":2},` +
		`{"day":"` + day(today) + `","avgPowerVa":800.0,"maxPowerVa":1000.0,"avgTemperatureC":30.0,"samples":2}]`
	if now.Sub(today) < 2*time.Second {
		t.Skip("too close to midnight UTC for fixed day buckets")
	}
	h.expect("GET", p, h.admin, "", 200, want)
	h.expect("GET", p+"?days=0", h.admin, "", 200, "") // clamped to 1, not an error
	got := h.expect("GET", p+"?days=30", h.admin, "", 200, "")
	if !strings.HasPrefix(got, `[{"day":"`+day(today.AddDate(0, 0, -10))+`","avgPowerVa":100.0,"maxPowerVa":100.0,"avgTemperatureC":20.0,"samples":1},`) {
		t.Fatalf("30 day trend = %s", got)
	}

	// An empty window is [], not null.
	empty := newHarness(t, options{})
	empty.expect("GET", p, empty.admin, "", 200, `[]`)
}

func equal(a, b []int64) bool {
	if len(a) != len(b) {
		return false
	}
	for i := range a {
		if a[i] != b[i] {
			return false
		}
	}
	return true
}
