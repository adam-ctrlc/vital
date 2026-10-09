//go:build sqlite

package app

import (
	"encoding/json"
	"io"
	"net/http"
	"strings"
	"testing"

	"github.com/google/uuid"

	"github.com/adam-ctrlc/vital/api/internal/auth"
)

func userToken() string {
	tok, _ := auth.NewGuard("test-secret", "").Issue(uuid.New(), auth.User)
	return tok
}

// auditPage reads GET /audit with query and returns the total and the rows.
func (h *harness) auditPage(query string) (int, []map[string]any) {
	h.t.Helper()
	body := h.expect("GET", "/api/v1/audit"+query, h.admin, "", 200, "")
	var page struct {
		Rows  []map[string]any `json:"rows"`
		Total int              `json:"total"`
	}
	if err := json.Unmarshal([]byte(body), &page); err != nil {
		h.t.Fatalf("audit page %s: %v", body, err)
	}
	return page.Total, page.Rows
}

func detailJSON(t *testing.T, row map[string]any) string {
	t.Helper()
	b, _ := json.Marshal(row["detail"])
	return string(b)
}

func TestAnalysisSettings(t *testing.T) {
	h := newHarness(t)
	const base = `"loadThresholdVa":900,"tripThresholdVa":980,"tempThresholdC":40,"recloseDelaySeconds":30`

	h.expect("PUT", "/api/v1/settings", h.admin, `{`+base+`,"energyRatePerKwh":1001}`, 400,
		`{"error":"Energy rate must be between 0 and 1000 per kWh"}`)
	h.expect("PUT", "/api/v1/settings", h.admin, `{`+base+`,"energyRatePerKwh":-1}`, 400, "")
	h.expect("PUT", "/api/v1/settings", h.admin, `{`+base+`,"nominalVoltageV":40}`, 400,
		`{"error":"Nominal voltage must be between 50 and 500 V"}`)
	h.expect("PUT", "/api/v1/settings", h.admin, `{`+base+`,"nominalVoltageV":"230"}`, 422, "")

	got := h.expect("PUT", "/api/v1/settings", h.admin, `{`+base+`,"energyRatePerKwh":11.5,"nominalVoltageV":230}`, 200, "")
	if !strings.Contains(got, `"sourceMode":"hardware","energyRatePerKwh":11.5,"nominalVoltageV":230.0,"updatedAt":`) {
		t.Errorf("settings = %s", got)
	}
	// Absent keeps them; an unchanged save records nothing.
	got = h.expect("PUT", "/api/v1/settings", h.admin, `{`+base+`}`, 200, "")
	if !strings.Contains(got, `"energyRatePerKwh":11.5,"nominalVoltageV":230.0`) {
		t.Errorf("absent fields reset: %s", got)
	}

	total, rows := h.auditPage("?action=settings.update")
	if total != 1 {
		t.Fatalf("settings.update events = %d %v", total, rows)
	}
	if rows[0]["actorName"] != "Ada Admin" || rows[0]["actorId"] != h.adminID.String() || rows[0]["target"] != "settings" {
		t.Errorf("event = %v", rows[0])
	}
	if d := detailJSON(t, rows[0]); d != `{"energyRatePerKwh":{"from":12,"to":11.5},"nominalVoltageV":{"from":120,"to":230}}` {
		t.Errorf("detail = %s", d)
	}
	// The raw response keeps the API's float format.
	raw := h.expect("GET", "/api/v1/audit?action=settings.update", h.admin, "", 200, "")
	if !strings.Contains(raw, `"detail":{"energyRatePerKwh":{"from":12.0,"to":11.5},"nominalVoltageV":{"from":120.0,"to":230.0}}`) {
		t.Errorf("raw = %s", raw)
	}

	h.expect("PUT", "/api/v1/settings", h.admin, `{"loadThresholdVa":850,"tripThresholdVa":980,"tempThresholdC":40,"recloseDelaySeconds":30,"tripConfirmSeconds":5}`, 200, "")
	_, rows = h.auditPage("?action=settings.update&limit=1")
	if d := detailJSON(t, rows[0]); d != `{"loadThresholdVa":{"from":900,"to":850},"tripConfirmSeconds":{"from":3,"to":5}}` {
		t.Errorf("threshold detail = %s", d)
	}

	h.expect("PUT", "/api/v1/settings/source", h.admin, `{"sourceMode":"simulation"}`, 200, "")
	h.expect("PUT", "/api/v1/settings/source", h.admin, `{"sourceMode":"simulation"}`, 200, "")
	total, rows = h.auditPage("?action=settings.source")
	if total != 1 || rows[0]["target"] != "source mode" || detailJSON(t, rows[0]) != `{"from":"hardware","to":"simulation"}` {
		t.Errorf("source events = %d %v", total, rows)
	}
}

func TestAuditTrail(t *testing.T) {
	h := newHarness(t)

	h.expect("POST", "/api/v1/users", h.admin, `{"password":"password1","role":"user","firstName":"Ben","lastName":"Cruz"}`, 201, "")
	list := h.expect("GET", "/api/v1/users?q=bcruz", h.admin, "", 200, "")
	var found []map[string]any
	_ = json.Unmarshal([]byte(list), &found)
	id := found[0]["id"].(string)

	h.expect("PUT", "/api/v1/users/"+id, h.admin, `{"role":"user","firstName":"Ben","lastName":"Santos","password":"new-password-1"}`, 200, "")
	h.expect("PUT", "/api/v1/users/"+id, h.admin, `{"role":"user","firstName":"Ben","lastName":"Santos"}`, 200, "") // no change

	h.expect("POST", "/api/v1/auth/register", "", `{"firstName":"Cara","lastName":"Diaz","password":"cara-password"}`, 201, "")
	list = h.expect("GET", "/api/v1/users?status=pending", h.admin, "", 200, "")
	_ = json.Unmarshal([]byte(list), &found)
	pending := found[0]["id"].(string)
	h.expect("POST", "/api/v1/users/"+pending+"/approve", h.admin, "", 200, "")
	h.expect("POST", "/api/v1/users/"+pending+"/approve", h.admin, "", 200, "") // already active

	h.expect("DELETE", "/api/v1/users/"+id, h.admin, "", 204, "")
	h.expect("POST", "/api/v1/device/relay", h.admin, `{"command":"open"}`, 200, "")
	h.expect("POST", "/api/v1/device/relay", h.admin, `{"command":"close"}`, 200, "")
	h.expect("PUT", "/api/v1/auth/me", h.admin, `{"firstName":"Ada","middleName":"B","lastName":"Lovelace"}`, 200, "")
	h.expect("PUT", "/api/v1/auth/password", h.admin, `{"currentPassword":"admin-password","newPassword":"admin-password-2"}`, 204, "")

	raw := h.expect("GET", "/api/v1/audit", h.admin, "", 200, "")
	if strings.Contains(raw, "argon2") || strings.Contains(raw, "new-password-1") {
		t.Fatalf("a password or hash leaked into the audit log: %s", raw)
	}

	total, rows := h.auditPage("")
	want := []struct{ action, target, detail, actor string }{
		{"account.password", "Ada B Lovelace", "null", "Ada B Lovelace"},
		{"account.update", "Ada B Lovelace", `{"lastName":{"from":"Admin","to":"Lovelace"},"middleName":{"from":null,"to":"B"}}`, "Ada B Lovelace"},
		{"relay.close", "relay", "null", "Ada Admin"},
		{"relay.open", "relay", "null", "Ada Admin"},
		{"user.delete", "Ben Santos", `{"role":"user","username":"bcruz"}`, "Ada Admin"},
		{"user.approve", "Cara Diaz", `{"username":"cdiaz"}`, "Ada Admin"},
		{"user.update", "Ben Santos", `{"lastName":{"from":"Cruz","to":"Santos"},"password":{"from":null,"to":"changed"}}`, "Ada Admin"},
		{"user.create", "Ben Cruz", `{"email":null,"role":"user","username":"bcruz"}`, "Ada Admin"},
	}
	if total != len(want) {
		t.Fatalf("total = %d, want %d: %v", total, len(want), rows)
	}
	for i, w := range want {
		r := rows[i]
		if r["action"] != w.action || r["target"] != w.target || detailJSON(t, r) != w.detail || r["actorName"] != w.actor {
			t.Errorf("row %d = %v %v %s %v, want %+v", i, r["action"], r["target"], detailJSON(t, r), r["actorName"], w)
		}
		if r["actorId"] != h.adminID.String() {
			t.Errorf("row %d actorId = %v", i, r["actorId"])
		}
	}

	total, rows = h.auditPage("?action=user.")
	if total != 4 || rows[0]["action"] != "user.delete" || rows[3]["action"] != "user.create" {
		t.Errorf("user. prefix = %d %v", total, rows)
	}
	if total, _ := h.auditPage("?action=user"); total != 0 {
		t.Errorf("exact 'user' matched %d", total)
	}
	if total, _ := h.auditPage("?action=%25."); total != 0 {
		t.Errorf("a LIKE wildcard matched %d", total)
	}
	total, rows = h.auditPage("?limit=2&offset=1")
	if total != 8 || len(rows) != 2 || rows[0]["action"] != "account.update" {
		t.Errorf("paging = %d %v", total, rows)
	}
	page := h.expect("GET", "/api/v1/audit?limit=0&offset=-5", h.admin, "", 200, "")
	if !strings.HasSuffix(page, `"total":8,"limit":1,"offset":0}`) {
		t.Errorf("clamped page = %s", page)
	}
	h.expect("GET", "/api/v1/audit?limit=x", h.admin, "", 400, "")
	h.expect("GET", "/api/v1/audit", userToken(), "", 403, `{"error":"Admin access required"}`)
	h.expect("GET", "/api/v1/audit", "", "", 401, "")
}

// seedAnalysis loads the hand-worked fixture of internal/insights/compute_test.go
// (Thursday 24 September 2026, 23:59:40 Manila onwards), plus readings and alerts that
// fall outside it.
func seedAnalysis(t *testing.T, h *harness) {
	t.Helper()
	conn := h.conn
	exec := func(q string, args ...any) {
		t.Helper()
		if _, err := conn.Exec(q, args...); err != nil {
			t.Fatal(err)
		}
	}
	const insert = `insert into readings (voltage_v, current_a, temperature_c, apparent_power_va, power_w, power_factor,
		frequency_hz, energy_kwh, relay_closed, status, source, recorded_at, load_threshold_va, trip_threshold_va)
		values (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14)`
	exec(insert, 120, 0.833, 40, 100, 90, 0.9, 60, 1.000, 1, "normal", "hardware", "2026-09-24T15:59:40.000Z", 900, 980)
	exec(insert, 100, 5, 50, 500, 300, 0.6, 60, 1.010, 1, "overload", "hardware", "2026-09-24T16:00:10.000Z", 400, 980)
	exec(insert, 105, 1.905, nil, 200, 5, 0.5, 60, 0.500, 0, "normal", "hardware", "2026-09-24T16:02:10.000Z", nil, nil)
	exec(insert, 135, nil, 60, nil, nil, nil, nil, 0.520, nil, "normal", "hardware", "2026-09-24T16:02:20.000Z", 900, 980)
	// Outside: the day before (Manila) and a simulator row.
	exec(insert, 230, 1, 30, 230, 230, 1, 60, 9, nil, "normal", "hardware", "2026-09-23T15:59:59.000Z", 900, 980)
	exec(insert, 230, 1, 30, 230, 230, 1, 60, 9, nil, "normal", "simulator", "2026-09-24T05:00:00.000Z", 900, 980)

	exec(`insert into alerts (kind, message, value, threshold, created_at, acknowledged_at, acknowledged_by, response_ms)
		values ('overload', 'm', 500, 400, '2026-09-24T16:00:10.000Z', '2026-09-24T16:00:30.000Z', ?1, 20000)`, h.adminID.String())
	exec(`insert into alerts (kind, message, value, threshold, created_at, acknowledged_at, acknowledged_by, response_ms)
		values ('temperature', 'm', 45, 40, '2026-09-25T02:00:00.000Z', null, null, null)`)
	exec(`insert into alerts (kind, message, value, threshold, created_at)
		values ('overload', 'm', 999, 900, '2026-09-20T02:00:00.000Z')`)

	h.expect("PUT", "/api/v1/settings", h.admin, `{"loadThresholdVa":400,"tripThresholdVa":980,"tempThresholdC":40,"recloseDelaySeconds":30,"energyRatePerKwh":10,"nominalVoltageV":120}`, 200, "")
}

func TestInsightsEndpoint(t *testing.T) {
	h := newHarness(t)
	seedAnalysis(t, h)

	got := h.expect("GET", "/api/v1/insights?from=2026-09-24&to=2026-09-25", h.admin, "", 200, "")
	for _, want := range []string{
		`{"from":"2026-09-24","to":"2026-09-25","source":"hardware","samples":4,`,
		`"energy":{"ratePerKwh":10.0,"totalKwh":0.03,"totalCost":0.3,"peakVa":500.0,"peakAt":"2026-09-24T16:00:10Z","overloadMinutes":1.0,"days":[` +
			`{"date":"2026-09-24","kwh":0.0,"cost":0.0,"avgVa":100.0,"peakVa":100.0,"overloadMinutes":0.0,"samples":1},` +
			`{"date":"2026-09-25","kwh":0.03,"cost":0.3,"avgVa":457.1,"peakVa":500.0,"overloadMinutes":1.0,"samples":3}]}`,
		`"heatmap":[{"weekday":3,"hour":23,"avgVa":100.0,"maxVa":100.0,"overloadMinutes":0.0,"samples":1},{"weekday":4,"hour":0,"avgVa":457.1,"maxVa":500.0,"overloadMinutes":1.0,"samples":3}]`,
		`"powerQuality":{"nominalVoltageV":120.0,"minVoltageV":100.0,"avgVoltageV":107.9,"maxVoltageV":135.0,"sagMinutes":1.2,"swellMinutes":0.1,"events":[` +
			`{"at":"2026-09-24T16:00:10Z","kind":"sag","voltageV":100.0,"durationSeconds":60},` +
			`{"at":"2026-09-24T16:02:10Z","kind":"sag","voltageV":105.0,"durationSeconds":10},` +
			`{"at":"2026-09-24T16:02:20Z","kind":"swell","voltageV":135.0,"durationSeconds":5}],` +
			`"avgPowerFactor":0.7,"lowPowerFactorMinutes":1.0,"correction":{"targetPowerFactor":0.95,"basisPowerW":230.0,"basisPowerFactor":0.7,"kvar":0.159,"capacitorUf":29.3}}`,
		`"aging":{"method":"IEEE C57.91","referenceTempC":110,"normalLifeHours":180000,`,
		`"avgTempC":47.4,"maxTempC":60.0,`,
		`"periodHours":48.0,`,
		`"alerts":{"total":2,"overload":1,"temperature":1,"unacknowledged":1,"medianResponseSeconds":20.0,` +
			`"byPerson":[{"userId":"` + h.adminID.String() + `","name":"Ada Admin","count":1,"medianResponseSeconds":20.0}],` +
			`"rows":[{"id":2,"kind":"temperature","value":45.0,"threshold":40.0,"createdAt":"2026-09-25T02:00:00Z","acknowledgedAt":null,"responseMs":null,"acknowledgedByName":null},` +
			`{"id":1,"kind":"overload","value":500.0,"threshold":400.0,"createdAt":"2026-09-24T16:00:10Z","acknowledgedAt":"2026-09-24T16:00:30Z","responseMs":20000,"acknowledgedByName":"Ada Admin"}]}}`,
	} {
		if !strings.Contains(got, want) {
			t.Errorf("missing\n%s\nin\n%s", want, got)
		}
	}

	// The simulator feed on its own: one sample that day. Alerts are not per feed, and
	// the overload alert at 16:00:10 UTC is already the 25th in Manila.
	got = h.expect("GET", "/api/v1/insights?from=2026-09-24&to=2026-09-24&source=simulator", h.admin, "", 200, "")
	if !strings.Contains(got, `"source":"simulator","samples":1,`) || !strings.Contains(got, `"alerts":{"total":0,`) {
		t.Errorf("simulator = %s", got)
	}
	got = h.expect("GET", "/api/v1/insights?from=2026-09-23&to=2026-09-25&source=all", h.admin, "", 200, "")
	if !strings.Contains(got, `"source":"all","samples":6,`) || !strings.Contains(got, `"alerts":{"total":2,`) {
		t.Errorf("all = %.200s", got)
	}

	h.expect("GET", "/api/v1/insights?from=2026-09-26&to=2026-09-25", h.admin, "", 400, `{"error":"From is after to"}`)
	h.expect("GET", "/api/v1/insights?source=solar", h.admin, "", 400, `{"error":"Invalid source: solar"}`)
	h.expect("GET", "/api/v1/insights", userToken(), "", 403, `{"error":"Admin access required"}`)
	got = h.expect("GET", "/api/v1/insights", h.admin, "", 200, "") // default: the last week
	if !strings.Contains(got, `"source":"hardware","samples":0,`) {
		t.Errorf("default range = %.200s", got)
	}
}

func TestReadingsExport(t *testing.T) {
	h := newHarness(t)
	seedAnalysis(t, h)

	req, _ := http.NewRequest("GET", h.srv.URL+"/api/v1/readings/export?from=2026-09-24&to=2026-09-25", nil)
	req.Header.Set("Authorization", "Bearer "+h.admin)
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	body, _ := io.ReadAll(resp.Body)
	resp.Body.Close()
	if resp.StatusCode != 200 || resp.Header.Get("Content-Type") != "text/csv; charset=utf-8" ||
		resp.Header.Get("Content-Disposition") != `attachment; filename="vital-readings-2026-09-24-to-2026-09-25.csv"` {
		t.Fatalf("export = %d %v", resp.StatusCode, resp.Header)
	}
	want := "time,voltage_v,current_a,apparent_power_va,power_w,power_factor,frequency_hz,energy_kwh,temperature_c,status,source,alarm_va,trip_va,relay_closed\n" +
		"2026-09-24 23:59:40,120,0.833,100,90,0.9,60,1,40,normal,hardware,900,980,true\n" +
		"2026-09-25 00:00:10,100,5,500,300,0.6,60,1.01,50,overload,hardware,400,980,true\n" +
		"2026-09-25 00:02:10,105,1.905,200,5,0.5,60,0.5,,normal,hardware,,,false\n" +
		"2026-09-25 00:02:20,135,,,,,,0.52,60,normal,hardware,900,980,\n"
	if string(body) != want {
		t.Errorf("csv =\n%s\nwant\n%s", body, want)
	}

	h.expect("GET", "/api/v1/readings/export?from=2026-09-24&to=2026-09-24&source=all", h.admin, "", 200,
		"time,voltage_v,current_a,apparent_power_va,power_w,power_factor,frequency_hz,energy_kwh,temperature_c,status,source,alarm_va,trip_va,relay_closed\n"+
			"2026-09-24 13:00:00,230,1,230,230,1,60,9,30,normal,simulator,900,980,\n"+
			"2026-09-24 23:59:40,120,0.833,100,90,0.9,60,1,40,normal,hardware,900,980,true\n")
	h.expect("GET", "/api/v1/readings/export?from=bad", h.admin, "", 400, "")
	h.expect("GET", "/api/v1/readings/export", userToken(), "", 403, "")
	// The history route beside it still answers.
	h.expect("GET", "/api/v1/readings?limit=1", h.admin, "", 200, "")
}
