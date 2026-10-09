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

	"github.com/google/uuid"

	api "github.com/adam-ctrlc/vital/api"
	"github.com/adam-ctrlc/vital/api/internal/alerts"
	"github.com/adam-ctrlc/vital/api/internal/auth"
	"github.com/adam-ctrlc/vital/api/internal/config"
	"github.com/adam-ctrlc/vital/api/internal/db"
	"github.com/adam-ctrlc/vital/api/internal/notifications"
)

// fakeExpo stands in for exp.host: it records each batch it is sent.
type fakeExpo struct {
	mu      sync.Mutex
	batches [][]map[string]any
}

func (f *fakeExpo) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	var batch []map[string]any
	body, _ := io.ReadAll(r.Body)
	_ = json.Unmarshal(body, &batch)
	f.mu.Lock()
	f.batches = append(f.batches, batch)
	f.mu.Unlock()
	_, _ = io.WriteString(w, `{"data":[]}`)
}

func (f *fakeExpo) sent() [][]map[string]any {
	f.mu.Lock()
	defer f.mu.Unlock()
	return append([][]map[string]any(nil), f.batches...)
}

type alertHarness struct {
	*harness
	conn   *sql.DB
	deps   Deps
	expo   *fakeExpo
	user   string // standard user token
	userID uuid.UUID
}

// newAlertHarness is newHarness with a second, standard user, and with pushes going
// to a fake Expo (nil push keeps the default, which refuses under go test).
func newAlertHarness(t *testing.T, fake bool) *alertHarness {
	t.Helper()
	conn, err := db.Open("file:"+filepath.Join(t.TempDir(), "alerts.db"), "")
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { conn.Close() })
	if _, err := db.ApplySchema(context.Background(), conn, api.Schema); err != nil {
		t.Fatal(err)
	}

	adminID, userID := uuid.New(), uuid.New()
	for _, u := range []struct {
		id         uuid.UUID
		name, role string
	}{{adminID, "admin", "admin"}, {userID, "lineman", "user"}} {
		if _, err := conn.Exec(`insert into users (id, username, password_hash, role, first_name, last_name)
			values (?1, ?2, 'x', ?3, 'A', 'B')`, u.id.String(), u.name, u.role); err != nil {
			t.Fatal(err)
		}
	}

	d := NewDeps(config.Config{JWTSecret: "test-secret", DeviceAPIKey: deviceKey}, conn)
	h := &alertHarness{conn: conn, userID: userID}
	if fake {
		h.expo = &fakeExpo{}
		expo := httptest.NewServer(h.expo)
		t.Cleanup(expo.Close)
		d = d.WithPush(notifications.NewExpoSender(expo.Client(), expo.URL+"/--/api/v2/push/send"))
	}
	h.deps = d

	srv := httptest.NewServer(Routes(d))
	t.Cleanup(srv.Close)
	admin, _ := d.Guard.Issue(adminID, auth.Admin)
	h.user, _ = d.Guard.Issue(userID, auth.User)
	h.harness = &harness{t: t, srv: srv, admin: admin, adminID: adminID}
	return h
}

// ingest posts a reading as the board does and expects it stored.
func (h *alertHarness) ingest(body string) {
	h.t.Helper()
	req, _ := http.NewRequest("POST", h.srv.URL+"/api/v1/readings", strings.NewReader(body))
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("x-device-key", deviceKey)
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		h.t.Fatal(err)
	}
	defer resp.Body.Close()
	got, _ := io.ReadAll(resp.Body)
	if resp.StatusCode != 200 {
		h.t.Fatalf("ingest %s: %d %s", body, resp.StatusCode, got)
	}
}

func (h *alertHarness) page(path string) (total int, rows []map[string]any) {
	h.t.Helper()
	var p struct {
		Rows  []map[string]any `json:"rows"`
		Total int              `json:"total"`
	}
	if err := json.Unmarshal([]byte(h.expect("GET", path, h.user, "", 200, "")), &p); err != nil {
		h.t.Fatal(err)
	}
	return p.Total, p.Rows
}

func TestPushRegistration(t *testing.T) {
	h := newAlertHarness(t, true)
	const p = "/api/v1/notifications"

	h.expect("POST", p+"/register", "", `{"token":"t"}`, 401, `{"error":"Missing or invalid token"}`)
	h.expect("POST", p+"/register", h.user, `{}`, 422, "")
	h.expect("POST", p+"/register", h.user, `{"token":null}`, 422, "")
	h.expect("POST", p+"/register", h.user, `{"token":`, 400, "")
	h.expect("POST", p+"/register", h.user, `{"token":"  "}`, 400, `{"error":"Push token is required"}`)
	status, _ := h.do("POST", p+"/register", h.user, "") // no body, no content type
	if status != 415 {
		t.Errorf("no content type = %d, want 415", status)
	}

	h.expect("POST", p+"/register", h.user, `{"token":" ExponentPushToken[a] ","platform":"android","channelId":" siren "}`, 204, "")
	h.expect("POST", p+"/register", h.user, `{"token":"ExponentPushToken[b]","channelId":"  "}`, 204, "")
	// Re-registering moves the token to the caller with its new details.
	h.expect("POST", p+"/register", h.admin, `{"token":"ExponentPushToken[b]","platform":"ios"}`, 204, "")

	type row struct {
		token, user, platform string
		channel               sql.NullString
	}
	read := func() []row {
		rs, err := h.conn.Query(`select token, user_id, platform, channel_id from push_tokens order by token`)
		if err != nil {
			t.Fatal(err)
		}
		defer rs.Close()
		var out []row
		for rs.Next() {
			var r row
			if err := rs.Scan(&r.token, &r.user, &r.platform, &r.channel); err != nil {
				t.Fatal(err)
			}
			out = append(out, r)
		}
		return out
	}
	got := read()
	if len(got) != 2 ||
		got[0] != (row{"ExponentPushToken[a]", h.userID.String(), "android", sql.NullString{String: "siren", Valid: true}}) ||
		got[1] != (row{"ExponentPushToken[b]", h.adminID.String(), "ios", sql.NullString{}}) {
		t.Fatalf("push_tokens = %+v", got)
	}

	// Unregister removes only the caller's own registration, and never fails.
	h.expect("POST", p+"/unregister", h.user, `{"token":"ExponentPushToken[b]"}`, 204, "")
	h.expect("POST", p+"/unregister", h.user, `{"token":"   "}`, 204, "")
	h.expect("POST", p+"/unregister", h.user, `{}`, 422, "")
	if len(read()) != 2 {
		t.Fatal("unregister removed another account's token")
	}
	h.expect("POST", p+"/unregister", h.user, `{"token":" ExponentPushToken[a] "}`, 204, "")
	if got := read(); len(got) != 1 || got[0].token != "ExponentPushToken[b]" {
		t.Fatalf("after unregister: %+v", got)
	}
}

func TestAlertLifecycle(t *testing.T) {
	h := newAlertHarness(t, true)
	h.expect("POST", "/api/v1/notifications/register", h.user, `{"token":"ExponentPushToken[a]","channelId":"siren"}`, 204, "")
	h.expect("POST", "/api/v1/notifications/register", h.admin, `{"token":"ExponentPushToken[b]"}`, 204, "")

	h.expect("GET", "/api/v1/alerts", "", "", 401, "")
	h.expect("GET", "/api/v1/alerts", h.user, "", 200, `{"rows":[],"total":0,"limit":20,"offset":0}`)

	// An overload opens one alert and pushes it to every device.
	h.ingest(`{"voltageV":230,"currentA":4.5,"powerFactor":0.9}`)
	sent := h.expo.sent()
	if len(sent) != 1 || len(sent[0]) != 2 {
		t.Fatalf("pushes = %v", sent)
	}
	byToken := map[string]map[string]any{}
	for _, m := range sent[0] {
		byToken[m["to"].(string)] = m
	}
	a, b := byToken["ExponentPushToken[a]"], byToken["ExponentPushToken[b]"]
	if a["title"] != "Transformer overloaded" || a["body"] != "Load reached 1035 VA" || a["priority"] != "high" ||
		a["sound"] != "default" || a["channelId"] != "siren" {
		t.Errorf("message = %v", a)
	}
	if _, has := b["channelId"]; has {
		t.Errorf("channelId sent for a device without one: %v", b)
	}
	data := a["data"].(map[string]any)
	alertID := int64(data["alertId"].(float64))
	if data["kind"] != "overload" {
		t.Errorf("data = %v", data)
	}

	// A fast heartbeat over the same condition neither opens nor announces again.
	h.ingest(`{"voltageV":231,"currentA":4.6}`)
	if n := len(h.expo.sent()); n != 1 {
		t.Fatalf("pushes after a repeat = %d, want 1", n)
	}
	// Once it is due, the same alert is announced again.
	if _, err := h.conn.Exec(`update alerts set last_notified_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now', '-61 seconds')`); err != nil {
		t.Fatal(err)
	}
	h.ingest(`{"voltageV":231,"currentA":4.6}`)
	sent = h.expo.sent()
	if len(sent) != 2 || int64(sent[1][0]["data"].(map[string]any)["alertId"].(float64)) != alertID ||
		sent[1][0]["body"] != "Load reached 1035 VA" {
		t.Fatalf("re-announcement = %v", sent)
	}

	// Listed once, with the measurements of the reading that opened it.
	got := h.expect("GET", "/api/v1/alerts?active=true", h.user, "", 200, "")
	re := regexp.MustCompile(`^\{"rows":\[\{"id":\d+,"readingId":\d+,"kind":"overload","message":"Load reached 1035 VA",` +
		`"value":1035\.0,"threshold":900\.0,"createdAt":"[^"]+Z","acknowledgedAt":null,"acknowledgedBy":null,` +
		`"responseMs":null,"voltageV":230\.0,"currentA":4\.5,"temperatureC":null,"apparentPowerVa":1035\.0,` +
		`"powerW":null,"powerFactor":0\.9,"frequencyHz":null,"energyKwh":null\}\],"total":1,"limit":20,"offset":0\}$`)
	if !re.MatchString(got) {
		t.Errorf("list = %s", got)
	}

	// Filters.
	h.expect("GET", "/api/v1/alerts?kind=voltage", h.user, "", 400, `{"error":"Invalid alert kind: voltage"}`)
	h.expect("GET", "/api/v1/alerts?limit=ten", h.user, "", 400, "")
	h.expect("GET", "/api/v1/alerts?active=1", h.user, "", 400, "")
	if total, _ := h.page("/api/v1/alerts?kind=temperature"); total != 0 {
		t.Errorf("temperature total = %d", total)
	}
	if total, _ := h.page("/api/v1/alerts?q=LOAD"); total != 1 {
		t.Errorf("search total = %d", total)
	}
	if total, _ := h.page("/api/v1/alerts?q=over"); total != 1 {
		t.Errorf("kind search total = %d", total)
	}
	if total, _ := h.page("/api/v1/alerts?q=%25"); total != 0 {
		t.Errorf("wildcard search total = %d, want literal match", total)
	}
	if total, rows := h.page("/api/v1/alerts?limit=0&offset=5"); total != 1 || len(rows) != 0 {
		t.Errorf("window = %d %v", total, rows)
	}

	// Acknowledge.
	id := strings.TrimSpace(strings.Split(strings.TrimPrefix(got, `{"rows":[{"id":`), ",")[0])
	h.expect("POST", "/api/v1/alerts/abc/ack", h.user, "", 400, "Invalid URL: Cannot parse `abc` to a `i64`")
	h.expect("POST", "/api/v1/alerts/9999/ack", h.user, "", 404, `{"error":"Not found"}`)
	h.expect("POST", "/api/v1/alerts/"+id+"/ack", "", "", 401, "")
	acked := h.expect("POST", "/api/v1/alerts/"+id+"/ack", h.user, "", 200, "")
	if !regexp.MustCompile(`^\{"id":` + id + `,"readingId":\d+,"kind":"overload","message":"Load reached 1035 VA","value":1035\.0,` +
		`"threshold":900\.0,"createdAt":"[^"]+Z","acknowledgedAt":"[^"]+Z","acknowledgedBy":"` + h.userID.String() +
		`","responseMs":\d+\}$`).MatchString(acked) {
		t.Errorf("ack = %s", acked)
	}
	h.expect("POST", "/api/v1/alerts/"+id+"/ack", h.user, "", 404, `{"error":"Not found"}`)
	if total, _ := h.page("/api/v1/alerts?active=true"); total != 0 {
		t.Errorf("active after ack = %d", total)
	}

	// Once acknowledged, a new overload is a new alert; a temperature alert is its own.
	h.ingest(`{"voltageV":230,"currentA":4.5,"temperatureC":45.25}`)
	sent = h.expo.sent()
	if len(sent) != 4 {
		t.Fatalf("pushes = %d, want 4", len(sent))
	}
	if sent[3][0]["title"] != "Transformer overheating" || sent[3][0]["body"] != "Temperature reached 45.2 °C" {
		t.Errorf("temperature push = %v", sent[3][0])
	}
	total, rows := h.page("/api/v1/alerts")
	if total != 3 || rows[0]["kind"] != "temperature" && rows[1]["kind"] != "temperature" {
		t.Errorf("all alerts = %d %v", total, rows)
	}

	// An alert whose reading is gone is still listed, without measurements.
	if _, err := h.conn.Exec(`update alerts set reading_id = null where id = ?1`, id); err != nil {
		t.Fatal(err)
	}
	all := h.expect("GET", "/api/v1/alerts?active=false&limit=200", h.user, "", 200, "")
	if !strings.Contains(all, `"id":`+id+`,"readingId":null,`) ||
		!strings.Contains(all, `"voltageV":null,"currentA":null,"temperatureC":null,"apparentPowerVa":null,"powerW":null,"powerFactor":null,"frequencyHz":null,"energyKwh":null`) {
		t.Errorf("pruned reading = %s", all)
	}
}

// The partial unique index, not the pre-check, is what finally stops a duplicate:
// a second open of the same kind is "not opened" rather than an error.
func TestOpenLosesRaceQuietly(t *testing.T) {
	h := newAlertHarness(t, true)
	store := alerts.NewStore(h.conn)
	c := alerts.Condition{Kind: alerts.KindOverload, Message: "Load reached 950 VA", Value: 950, Threshold: 900}

	first, ok, err := store.Open(context.Background(), 1, c)
	if err != nil || !ok || first.ID == 0 {
		t.Fatalf("first open = %+v %v %v", first, ok, err)
	}
	_, ok, err = store.Open(context.Background(), 1, c)
	if err != nil || ok {
		t.Fatalf("second open = %v %v, want not opened and no error", ok, err)
	}
	// Not due yet: opened with last_notified_at = now.
	if _, ok, err := store.ClaimRenotify(context.Background(), alerts.KindOverload, alerts.RenotifyAfterSeconds); err != nil || ok {
		t.Fatalf("claim = %v %v, want nothing due", ok, err)
	}
	if id, ok, err := store.ActiveID(context.Background(), alerts.KindOverload); err != nil || !ok || id != first.ID {
		t.Fatalf("active = %d %v %v", id, ok, err)
	}
}

// Without WithPush, tests never reach Expo: the alert is still recorded and ingest
// still succeeds.
func TestDefaultPushNeverLeavesTests(t *testing.T) {
	h := newAlertHarness(t, false)
	h.expect("POST", "/api/v1/notifications/register", h.user, `{"token":"ExponentPushToken[real-looking]"}`, 204, "")
	h.ingest(`{"voltageV":230,"currentA":5}`)
	if total, _ := h.page("/api/v1/alerts?active=true"); total != 1 {
		t.Errorf("alert not recorded: total %d", total)
	}
}
