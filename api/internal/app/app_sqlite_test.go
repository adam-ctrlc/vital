//go:build sqlite

// End-to-end tests against a throwaway SQLite file built from schema.sql. Run with:
//
//	go test -tags sqlite ./internal/app/
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
	"testing"

	"github.com/google/uuid"

	api "github.com/adam-ctrlc/vital/api"
	"github.com/adam-ctrlc/vital/api/internal/auth"
	"github.com/adam-ctrlc/vital/api/internal/config"
	"github.com/adam-ctrlc/vital/api/internal/db"
)

type harness struct {
	t       *testing.T
	srv     *httptest.Server
	conn    *sql.DB
	admin   string // admin token
	adminID uuid.UUID
}

func newHarness(t *testing.T) *harness {
	t.Helper()
	path := filepath.Join(t.TempDir(), "test.db")
	conn, err := db.Open("file:"+path, "")
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { conn.Close() })
	if _, err := db.ApplySchema(context.Background(), conn, api.Schema); err != nil {
		t.Fatal(err)
	}

	adminID := uuid.New()
	hash, _ := auth.HashPassword("admin-password")
	if _, err := conn.Exec(`insert into users (id, email, username, password_hash, role, first_name, last_name)
		values (?1, 'admin@example.com', 'admin', ?2, 'admin', 'Ada', 'Admin')`, adminID.String(), hash); err != nil {
		t.Fatal(err)
	}

	cfg := config.Config{JWTSecret: "test-secret", DeviceAPIKey: "dev-key"}
	d := NewDeps(cfg, conn)
	srv := httptest.NewServer(Routes(d))
	t.Cleanup(srv.Close)

	tok, _ := d.Guard.Issue(adminID, auth.Admin)
	return &harness{t: t, srv: srv, conn: conn, admin: tok, adminID: adminID}
}

func (h *harness) do(method, path, token, body string) (int, string) {
	h.t.Helper()
	var rd io.Reader
	if body != "" {
		rd = strings.NewReader(body)
	}
	req, _ := http.NewRequest(method, h.srv.URL+path, rd)
	if body != "" {
		req.Header.Set("Content-Type", "application/json")
	}
	if token != "" {
		req.Header.Set("Authorization", "Bearer "+token)
	}
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		h.t.Fatal(err)
	}
	defer resp.Body.Close()
	b, _ := io.ReadAll(resp.Body)
	return resp.StatusCode, string(b)
}

func (h *harness) expect(method, path, token, body string, wantStatus int, wantBody string) string {
	h.t.Helper()
	status, got := h.do(method, path, token, body)
	if status != wantStatus {
		h.t.Fatalf("%s %s: status %d, want %d; body %s", method, path, status, wantStatus, got)
	}
	if wantBody != "" && got != wantBody {
		h.t.Fatalf("%s %s: body\n got %s\nwant %s", method, path, got, wantBody)
	}
	return got
}

func TestHealth(t *testing.T) {
	h := newHarness(t)
	got := h.expect("GET", "/api/v1/health", "", "", 200, "")
	re := regexp.MustCompile(`^\{"status":"ok","checkedAt":"\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(\.\d{3}|\.\d{6}|\.\d{9})?Z","checkedAtLabel":"[A-Z][a-z]+ \d{1,2}, \d{4} \d{1,2}:\d\d [AP]M"\}$`)
	if !re.MatchString(got) {
		t.Errorf("health = %s", got)
	}
}

func TestAccountLifecycle(t *testing.T) {
	h := newHarness(t)

	// Unknown account and wrong password read the same.
	h.expect("POST", "/api/v1/auth/login", "", `{"identifier":"ghost","password":"whatever1"}`, 401, `{"error":"Invalid credentials"}`)
	h.expect("POST", "/api/v1/auth/login", "", `{"email":"ADMIN@example.com ","password":"wrong-pass"}`, 401, `{"error":"Invalid credentials"}`)
	// Wrong portal, right password.
	h.expect("POST", "/api/v1/auth/login", "", `{"identifier":"admin","password":"admin-password","role":"user"}`, 401,
		`{"error":"You're an admin. Choose Admin above, then sign in"}`)
	h.expect("POST", "/api/v1/auth/login", "", `{"identifier":"admin","password":"admin-password","role":"nurse"}`, 422, "")
	h.expect("POST", "/api/v1/auth/login", "", `{"password":"admin-password"}`, 422, "")

	// Register: generated username, pending, 201.
	h.expect("POST", "/api/v1/auth/register", "", `{"firstName":"Juan","lastName":"Dela Cruz","password":"short"}`, 400,
		`{"error":"Password must be at least 8 characters"}`)
	h.expect("POST", "/api/v1/auth/register", "", `{"firstName":"Juan","lastName":"Dela Cruz","password":"juan-password","email":"Juan@Example.com"}`, 201,
		`{"username":"jdelacruz"}`)
	h.expect("POST", "/api/v1/auth/register", "", `{"firstName":"Juan","lastName":"Dela Cruz","password":"juan-password","email":"juan@example.com"}`, 400,
		`{"error":"Email already registered"}`)

	// Pending accounts cannot sign in, but only after the password checks out.
	h.expect("POST", "/api/v1/auth/login", "", `{"identifier":"jdelacruz","password":"bad-password"}`, 401, `{"error":"Invalid credentials"}`)
	h.expect("POST", "/api/v1/auth/login", "", `{"identifier":"juan@example.com","password":"juan-password"}`, 403,
		`{"error":"Your account is waiting for an admin to approve it"}`)

	// Admin sees it in the pending list and approves it.
	list := h.expect("GET", "/api/v1/users?status=pending", h.admin, "", 200, "")
	var pending []map[string]any
	if err := json.Unmarshal([]byte(list), &pending); err != nil || len(pending) != 1 {
		t.Fatalf("pending = %s", list)
	}
	id := pending[0]["id"].(string)
	if pending[0]["fullName"] != "Juan Dela Cruz" || pending[0]["middleName"] != nil || pending[0]["status"] != "pending" {
		t.Errorf("pending user = %v", pending[0])
	}
	h.expect("GET", "/api/v1/users?status=gone", h.admin, "", 400, `{"error":"Invalid status: gone"}`)
	h.expect("GET", "/api/v1/users?role=nurse", h.admin, "", 400, `{"error":"Invalid role: nurse"}`)
	approved := h.expect("POST", "/api/v1/users/"+id+"/approve", h.admin, "", 200, "")
	if !strings.Contains(approved, `"status":"active"`) {
		t.Errorf("approve = %s", approved)
	}
	h.expect("POST", "/api/v1/users/"+id+"/approve", h.admin, "", 200, "") // idempotent
	h.expect("POST", "/api/v1/users/"+uuid.NewString()+"/approve", h.admin, "", 404, `{"error":"Not found"}`)
	h.expect("POST", "/api/v1/users/not-a-uuid/approve", h.admin, "", 400, "")

	// Now it signs in.
	login := h.expect("POST", "/api/v1/auth/login", "", `{"identifier":" JDELACRUZ ","password":"juan-password","role":"user"}`, 200, "")
	var resp struct {
		Token string         `json:"token"`
		User  map[string]any `json:"user"`
	}
	if err := json.Unmarshal([]byte(login), &resp); err != nil {
		t.Fatal(err)
	}
	wantUser := `"user":{"id":"` + id + `","email":"juan@example.com","username":"jdelacruz","role":"user","firstName":"Juan","middleName":null,"lastName":"Dela Cruz","fullName":"Juan Dela Cruz"}}`
	if !strings.HasPrefix(login, `{"token":"`) || !strings.HasSuffix(login, wantUser) {
		t.Errorf("login = %s", login)
	}
	user := resp.Token

	// Profile.
	h.expect("GET", "/api/v1/auth/me", "", "", 401, `{"error":"Missing or invalid token"}`)
	h.expect("GET", "/api/v1/auth/me", user, "", 200, wantUser[len(`"user":`):len(wantUser)-1])
	h.expect("PUT", "/api/v1/auth/me", user, `{"firstName":"Juan","lastName":"Cruz","middleName":" Santos ","username":"jdelacruz","email":"JUAN@example.com"}`, 200, "")
	h.expect("PUT", "/api/v1/auth/me", user, `{"firstName":"Juan","lastName":"Cruz","username":"juan"}`, 403, `{"error":"Admin access required"}`)
	h.expect("PUT", "/api/v1/auth/me", user, `{"firstName":" ","lastName":"Cruz"}`, 400, `{"error":"First name is required"}`)
	me := h.expect("GET", "/api/v1/auth/me", user, "", 200, "")
	if !strings.Contains(me, `"middleName":"Santos","lastName":"Cruz","fullName":"Juan Santos Cruz"`) {
		t.Errorf("me = %s", me)
	}

	// Password.
	h.expect("PUT", "/api/v1/auth/password", user, `{"currentPassword":"juan-password","newPassword":"short"}`, 400,
		`{"error":"New password must be at least 8 characters"}`)
	h.expect("PUT", "/api/v1/auth/password", user, `{"currentPassword":"wrong-password","newPassword":"juan-password-2"}`, 401,
		`{"error":"Invalid credentials"}`)
	h.expect("PUT", "/api/v1/auth/password", user, `{"currentPassword":"juan-password","newPassword":"juan-password-2"}`, 204, "")
	h.expect("POST", "/api/v1/auth/login", "", `{"identifier":"jdelacruz","password":"juan-password-2"}`, 200, "")

	// A standard user is not an admin.
	h.expect("GET", "/api/v1/users", user, "", 403, `{"error":"Admin access required"}`)
}

func TestUserAdministration(t *testing.T) {
	h := newHarness(t)

	h.expect("GET", "/api/v1/users/username-suggestion?firstName=Ada&lastName=Admin", h.admin, "", 200, `{"username":"aadmin"}`)
	h.expect("GET", "/api/v1/users/username-suggestion?firstName=Ada", h.admin, "", 400, "Failed to deserialize query string: missing field `lastName`")

	h.expect("POST", "/api/v1/users", h.admin, `{"password":"password1","role":"user","firstName":"Ada","lastName":"Admin"}`, 201, "")
	h.expect("GET", "/api/v1/users/username-suggestion?firstName=Ada&lastName=Admin", h.admin, "", 200, `{"username":"aadmin2"}`)
	h.expect("POST", "/api/v1/users", h.admin, `{"password":"password1","role":"user","firstName":"Ada","lastName":"Admin","username":"AAdmin"}`, 400,
		`{"error":"Username already taken"}`)
	h.expect("POST", "/api/v1/users", h.admin, `{"password":"password1","role":"user","firstName":"Ada","lastName":"Admin","email":"nope"}`, 400,
		`{"error":"Invalid email"}`)
	h.expect("POST", "/api/v1/users", h.admin, `{"password":"password1","role":"boss","firstName":"Ada","lastName":"Admin"}`, 422, "")
	h.expect("POST", "/api/v1/users", h.admin, `{"password":"password1"}`, 422, "")
	h.expect("POST", "/api/v1/users", h.admin, `not json`, 400, "")

	// Search, with LIKE wildcards taken literally.
	list := h.expect("GET", "/api/v1/users?q=aadm", h.admin, "", 200, "")
	var found []map[string]any
	_ = json.Unmarshal([]byte(list), &found)
	if len(found) != 1 || found[0]["username"] != "aadmin" || found[0]["email"] != nil {
		t.Fatalf("search = %s", list)
	}
	h.expect("GET", "/api/v1/users?q=%25", h.admin, "", 200, "[]")
	h.expect("GET", "/api/v1/users?q=Ada%20Admin&role=user", h.admin, "", 200, "")
	id := found[0]["id"].(string)

	// Update.
	updated := h.expect("PUT", "/api/v1/users/"+id, h.admin, `{"role":"admin","firstName":"Ada","lastName":"Lovelace","email":"ADA@example.com","username":"","password":""}`, 200, "")
	if !strings.Contains(updated, `"email":"ada@example.com","username":"aadmin","role":"admin"`) {
		t.Errorf("update = %s", updated)
	}
	h.expect("PUT", "/api/v1/users/"+id, h.admin, `{"role":"user","firstName":"Ada","lastName":"Lovelace","email":"admin@example.com"}`, 409,
		`{"error":"Already exists"}`)
	h.expect("PUT", "/api/v1/users/"+h.adminID.String(), h.admin, `{"role":"user","firstName":"Ada","lastName":"Admin"}`, 400,
		`{"error":"You cannot change your own role"}`)
	h.expect("PUT", "/api/v1/users/"+uuid.NewString(), h.admin, `{"role":"user","firstName":"A","lastName":"B"}`, 404, "")

	// Delete.
	h.expect("DELETE", "/api/v1/users/"+h.adminID.String(), h.admin, "", 400, `{"error":"You cannot delete your own account"}`)
	h.expect("DELETE", "/api/v1/users/"+id, h.admin, "", 400, `{"error":"An admin cannot be deleted. Change the role to user first"}`)
	h.expect("PUT", "/api/v1/users/"+id, h.admin, `{"role":"user","firstName":"Ada","lastName":"Lovelace"}`, 200, "")
	h.expect("DELETE", "/api/v1/users/"+id, h.admin, "", 204, "")
	h.expect("DELETE", "/api/v1/users/"+id, h.admin, "", 404, `{"error":"Not found"}`)
}

func TestSettings(t *testing.T) {
	h := newHarness(t)
	user := func() string {
		g := auth.NewGuard("test-secret", "")
		tok, _ := g.Issue(uuid.New(), auth.User)
		return tok
	}()

	got := h.expect("GET", "/api/v1/settings", user, "", 200, "")
	if !regexp.MustCompile(`^\{"loadThresholdVa":900\.0,"tripThresholdVa":980\.0,"tempThresholdC":40\.0,"recloseDelaySeconds":30,"tripConfirmSeconds":3,"sourceMode":"hardware","energyRatePerKwh":12\.0,"nominalVoltageV":120\.0,"updatedAt":"[^"]+Z"\}$`).MatchString(got) {
		t.Errorf("settings = %s", got)
	}
	h.expect("PUT", "/api/v1/settings", user, `{}`, 403, "")
	h.expect("PUT", "/api/v1/settings", h.admin, `{"loadThresholdVa":900,"tripThresholdVa":900,"tempThresholdC":40,"recloseDelaySeconds":30}`, 400,
		`{"error":"Trip threshold must be greater than the alarm threshold"}`)
	h.expect("PUT", "/api/v1/settings", h.admin, `{"loadThresholdVa":900,"tripThresholdVa":980,"tempThresholdC":40}`, 422, "")
	got = h.expect("PUT", "/api/v1/settings", h.admin, `{"loadThresholdVa":850.5,"tripThresholdVa":950,"tempThresholdC":45,"recloseDelaySeconds":60}`, 200, "")
	if !strings.Contains(got, `"loadThresholdVa":850.5,"tripThresholdVa":950.0,"tempThresholdC":45.0,"recloseDelaySeconds":60,"tripConfirmSeconds":3`) {
		t.Errorf("update kept trip delay? %s", got)
	}
	got = h.expect("PUT", "/api/v1/settings", h.admin, `{"loadThresholdVa":850.5,"tripThresholdVa":950,"tempThresholdC":45,"recloseDelaySeconds":60,"tripConfirmSeconds":5}`, 200, "")
	if !strings.Contains(got, `"tripConfirmSeconds":5`) {
		t.Errorf("trip delay = %s", got)
	}
	h.expect("PUT", "/api/v1/settings/source", h.admin, `{"sourceMode":"magic"}`, 400, `{"error":"Source mode must be simulation or hardware"}`)
	got = h.expect("PUT", "/api/v1/settings/source", h.admin, `{"sourceMode":"simulation"}`, 200, "")
	if !strings.Contains(got, `"sourceMode":"simulation"`) {
		t.Errorf("source = %s", got)
	}
}

func TestRegisterRateLimit(t *testing.T) {
	h := newHarness(t)
	for range 3 {
		h.expect("POST", "/api/v1/auth/register", "", `{}`, 422, "")
	}
	// Whole seconds, floored: just under a minute remains by the time it is asked.
	got := h.expect("POST", "/api/v1/auth/register", "", `{}`, 429, "")
	if got != `{"error":"Too many attempts, try again in 59s"}` && got != `{"error":"Too many attempts, try again in 60s"}` {
		t.Errorf("429 body = %s", got)
	}
}

func TestCORSPreflightOnRoutes(t *testing.T) {
	h := newHarness(t)
	req, _ := http.NewRequest("OPTIONS", h.srv.URL+"/api/v1/auth/login", nil)
	req.Header.Set("Origin", "https://app.example")
	req.Header.Set("Access-Control-Request-Method", "POST")
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	resp.Body.Close()
	if resp.StatusCode != 200 || resp.Header.Get("Access-Control-Allow-Origin") != "*" {
		t.Errorf("preflight = %d %v", resp.StatusCode, resp.Header)
	}
}
