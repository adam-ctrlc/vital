package httpx

import (
	"errors"
	"fmt"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"
)

func TestErrorResponses(t *testing.T) {
	tests := []struct {
		name       string
		err        error
		wantStatus int
		wantBody   string
		wantType   string
	}{
		{"invalid credentials", ErrInvalidCredentials, 401, `{"error":"Invalid credentials"}`, "application/json"},
		{"unauthorized", ErrUnauthorized, 401, `{"error":"Missing or invalid token"}`, "application/json"},
		{"forbidden", ErrForbidden, 403, `{"error":"Admin access required"}`, "application/json"},
		{"pending", ErrPendingApproval, 403, `{"error":"Your account is waiting for an admin to approve it"}`, "application/json"},
		{"not found", ErrNotFound, 404, `{"error":"Not found"}`, "application/json"},
		{"bad request", BadRequest("invalid role: %s", "nurse"), 400, `{"error":"Invalid role: nurse"}`, "application/json"},
		{"already capitalised", BadRequest("Email already registered"), 400, `{"error":"Email already registered"}`, "application/json"},
		{"too many", TooManyRequests(7), 429, `{"error":"Too many attempts, try again in 7s"}`, "application/json"},
		{"hash", ErrPasswordHash, 500, `{"error":"Could not hash password"}`, "application/json"},
		{"token", ErrToken, 500, `{"error":"Could not create token"}`, "application/json"},
		{"upstream", Upstream("the settings row is missing"), 502, `{"error":"Upstream error: the settings row is missing"}`, "application/json"},
		{"unknown is a database error", errors.New("connection reset"), 500, `{"error":"Database error"}`, "application/json"},
		{"wrapped unique violation", fmt.Errorf("users: create: %w", errors.New("SQLite error: UNIQUE constraint failed: users.username")), 409, `{"error":"Already exists"}`, "application/json"},
		{"wrapped api error", fmt.Errorf("context: %w", ErrNotFound), 404, `{"error":"Not found"}`, "application/json"},
		{"rejection is plain text", rejection(415, "Expected request with `Content-Type: application/json`"), 415, "Expected request with `Content-Type: application/json`", "text/plain; charset=utf-8"},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			rec := httptest.NewRecorder()
			WriteError(rec, httptest.NewRequest("GET", "/", nil), tt.err)
			if rec.Code != tt.wantStatus {
				t.Errorf("status = %d, want %d", rec.Code, tt.wantStatus)
			}
			if rec.Body.String() != tt.wantBody {
				t.Errorf("body = %s, want %s", rec.Body.String(), tt.wantBody)
			}
			if ct := rec.Header().Get("Content-Type"); ct != tt.wantType {
				t.Errorf("content-type = %q, want %q", ct, tt.wantType)
			}
		})
	}
}

func TestSentenceCase(t *testing.T) {
	for in, want := range map[string]string{"invalid credentials": "Invalid credentials", "": "", "Email": "Email", "ñu": "Ñu"} {
		if got := SentenceCase(in); got != want {
			t.Errorf("SentenceCase(%q) = %q, want %q", in, got, want)
		}
	}
}

type decodeTarget struct {
	Name   string  `json:"name" required:"true"`
	Count  int32   `json:"count" required:"true"`
	Middle *string `json:"middle"`
}

func TestDecodeJSON(t *testing.T) {
	tests := []struct {
		name        string
		contentType string
		body        string
		wantStatus  int // 0 means success
		wantPrefix  string
	}{
		{"ok", "application/json", `{"name":"a","count":1}`, 0, ""},
		{"ok with charset and extra field", "application/json; charset=utf-8", `{"name":"a","count":1,"x":true,"middle":null}`, 0, ""},
		{"vendor json", "application/vnd.api+json", `{"name":"a","count":1}`, 0, ""},
		{"no content type", "", `{"name":"a","count":1}`, 415, "Expected request with `Content-Type: application/json`"},
		{"text content type", "text/plain", `{}`, 415, "Expected request"},
		{"empty body", "application/json", ``, 400, "Failed to parse the request body as JSON"},
		{"syntax", "application/json", `{"name":`, 400, "Failed to parse the request body as JSON"},
		{"trailing", "application/json", `{"name":"a","count":1} x`, 400, "Failed to parse the request body as JSON"},
		{"missing field", "application/json", `{"name":"a"}`, 422, "Failed to deserialize the JSON body into the target type: missing field `count`"},
		{"null required", "application/json", `{"name":null,"count":1}`, 422, "Failed to deserialize the JSON body into the target type: name: invalid type: null"},
		{"wrong type", "application/json", `{"name":"a","count":"1"}`, 422, "Failed to deserialize the JSON body into the target type: count: invalid type"},
		{"float into int", "application/json", `{"name":"a","count":1.5}`, 422, "Failed to deserialize"},
		{"case sensitive keys", "application/json", `{"Name":"a","count":1}`, 422, "Failed to deserialize the JSON body into the target type: missing field `name`"},
		{"array", "application/json", `[]`, 422, "Failed to deserialize"},
		{"null body", "application/json", `null`, 422, "Failed to deserialize"},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			r := httptest.NewRequest("POST", "/", strings.NewReader(tt.body))
			if tt.contentType != "" {
				r.Header.Set("Content-Type", tt.contentType)
			}
			var dst decodeTarget
			err := DecodeJSON(r, &dst)
			if tt.wantStatus == 0 {
				if err != nil {
					t.Fatalf("unexpected error: %v", err)
				}
				return
			}
			var apiErr *Error
			if !errors.As(err, &apiErr) {
				t.Fatalf("err = %v, want *Error", err)
			}
			if apiErr.Status != tt.wantStatus || !apiErr.Plain || !strings.HasPrefix(apiErr.Message, tt.wantPrefix) {
				t.Errorf("got %d %q (plain=%v), want %d %q...", apiErr.Status, apiErr.Message, apiErr.Plain, tt.wantStatus, tt.wantPrefix)
			}
		})
	}
}

func TestDecodeJSONBodyLimit(t *testing.T) {
	big := `{"name":"` + strings.Repeat("a", maxBody) + `","count":1}`
	r := httptest.NewRequest("POST", "/", strings.NewReader(big))
	r.Header.Set("Content-Type", "application/json")
	var apiErr *Error
	if err := DecodeJSON(r, &decodeTarget{}); !errors.As(err, &apiErr) || apiErr.Status != 413 {
		t.Fatalf("err = %v, want 413", err)
	}
}

func TestQuery(t *testing.T) {
	r := httptest.NewRequest("GET", "/?q=&limit=5&bad=x&active=true&f=1.5&empty=", nil)
	q := NewQuery(r)

	if v := q.String("q"); v == nil || *v != "" {
		t.Errorf("present empty string should be non-nil empty, got %v", v)
	}
	if q.String("absent") != nil {
		t.Error("absent string should be nil")
	}
	if Filter(q.String("q")) != nil {
		t.Error("blank filter should be nil")
	}
	if v := q.Int64("limit"); v == nil || *v != 5 {
		t.Errorf("limit = %v", v)
	}
	if v := q.Bool("active"); v == nil || !*v {
		t.Errorf("active = %v", v)
	}
	if v := q.Float64("f"); v == nil || *v != 1.5 {
		t.Errorf("f = %v", v)
	}
	if q.Err() != nil {
		t.Fatalf("unexpected error %v", q.Err())
	}

	q.Int64("empty") // serde_urlencoded refuses "" for an integer
	var apiErr *Error
	if err := q.Err(); !errors.As(err, &apiErr) || apiErr.Status != 400 || !strings.HasPrefix(apiErr.Message, "Failed to deserialize query string: ") {
		t.Fatalf("err = %v", err)
	}

	q2 := NewQuery(httptest.NewRequest("GET", "/?firstName=A", nil))
	q2.RequiredString("firstName")
	q2.RequiredString("lastName")
	if err := q2.Err(); err == nil || !strings.Contains(err.Error(), "missing field `lastName`") {
		t.Fatalf("err = %v", err)
	}
}

func TestPathUUID(t *testing.T) {
	mux := http.NewServeMux()
	var got string
	var gotErr error
	mux.HandleFunc("GET /u/{id}", func(w http.ResponseWriter, r *http.Request) {
		id, err := PathUUID(r, "id")
		got, gotErr = id.String(), err
	})

	tests := []struct {
		path, want string
		ok         bool
	}{
		{"/u/3F2B8C1E-4D5A-4B6C-9E7F-0A1B2C3D4E5F", "3f2b8c1e-4d5a-4b6c-9e7f-0a1b2c3d4e5f", true},
		{"/u/3f2b8c1e4d5a4b6c9e7f0a1b2c3d4e5f", "3f2b8c1e-4d5a-4b6c-9e7f-0a1b2c3d4e5f", true},
		{"/u/nope", "", false},
	}
	for _, tt := range tests {
		mux.ServeHTTP(httptest.NewRecorder(), httptest.NewRequest("GET", tt.path, nil))
		if tt.ok && (gotErr != nil || got != tt.want) {
			t.Errorf("%s: got %q, %v", tt.path, got, gotErr)
		}
		var apiErr *Error
		if !tt.ok && (!errors.As(gotErr, &apiErr) || apiErr.Status != 400) {
			t.Errorf("%s: err = %v, want 400", tt.path, gotErr)
		}
	}
}

func TestResolvePaging(t *testing.T) {
	p := func(v int64) *int64 { return &v }
	tests := []struct {
		limit, offset *int64
		wantL, wantO  int64
	}{
		{nil, nil, 50, 0},
		{p(0), p(-5), 1, 0},
		{p(1000), p(20), 200, 20},
		{p(10), nil, 10, 0},
	}
	for _, tt := range tests {
		l, o := ResolvePaging(tt.limit, tt.offset, 50, 200)
		if l != tt.wantL || o != tt.wantO {
			t.Errorf("got (%d,%d), want (%d,%d)", l, o, tt.wantL, tt.wantO)
		}
	}
	if b, _ := jsonOf(NewPage[int](nil, 0, 1, 0)); b != `{"rows":[],"total":0,"limit":1,"offset":0}` {
		t.Errorf("empty page = %s", b)
	}
}

func jsonOf(v any) (string, error) {
	rec := httptest.NewRecorder()
	WriteJSON(rec, 200, v)
	return rec.Body.String(), nil
}

func TestRateLimitConfigs(t *testing.T) {
	tests := []struct {
		name   string
		burst  int
		period time.Duration
	}{
		{"login", 10, 10 * time.Second},
		{"register", 3, 60 * time.Second},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			now := time.Unix(1_700_000_000, 0)
			l := NewRateLimit(tt.name, tt.burst, tt.period)
			l.now = func() time.Time { return now }

			for i := range tt.burst {
				if ok, _ := l.Allow("1.2.3.4"); !ok {
					t.Fatalf("request %d of the burst refused", i+1)
				}
			}
			ok, wait := l.Allow("1.2.3.4")
			if ok || wait != tt.period {
				t.Fatalf("over burst: ok=%v wait=%v, want refused with %v", ok, wait, tt.period)
			}
			if ok, _ := l.Allow("5.6.7.8"); !ok {
				t.Fatal("another caller should have its own bucket")
			}

			now = now.Add(tt.period - time.Second)
			if ok, wait := l.Allow("1.2.3.4"); ok || wait != time.Second {
				t.Fatalf("just before replenish: ok=%v wait=%v", ok, wait)
			}
			now = now.Add(time.Second)
			if ok, _ := l.Allow("1.2.3.4"); !ok {
				t.Fatal("one request should be allowed per period")
			}
			if ok, _ := l.Allow("1.2.3.4"); ok {
				t.Fatal("and only one")
			}
		})
	}
}

func TestRateLimitMiddleware(t *testing.T) {
	now := time.Unix(1_700_000_000, 0)
	l := NewRateLimit("login", 1, 10*time.Second)
	l.now = func() time.Time { return now }
	h := l.Middleware(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { w.WriteHeader(204) }))

	do := func() *httptest.ResponseRecorder {
		r := httptest.NewRequest("POST", "/", nil)
		r.Header.Set("X-Forwarded-For", "9.9.9.9, 10.0.0.1")
		rec := httptest.NewRecorder()
		h.ServeHTTP(rec, r)
		return rec
	}
	if rec := do(); rec.Code != 204 {
		t.Fatalf("first = %d", rec.Code)
	}
	now = now.Add(9500 * time.Millisecond) // 0.5s left: floored to 0, reported as 1
	if rec := do(); rec.Code != 429 || rec.Body.String() != `{"error":"Too many attempts, try again in 1s"}` {
		t.Fatalf("second = %d %s", rec.Code, rec.Body.String())
	}
}

func TestClientIP(t *testing.T) {
	tests := []struct {
		name    string
		headers map[string]string
		remote  string
		want    string
	}{
		{"xff first valid", map[string]string{"X-Forwarded-For": "garbage, 203.0.113.9, 10.0.0.1"}, "127.0.0.1:1", "203.0.113.9"},
		{"real ip", map[string]string{"X-Real-IP": "198.51.100.2"}, "127.0.0.1:1", "198.51.100.2"},
		{"forwarded", map[string]string{"Forwarded": `for="[2001:db8::1]:4711";proto=https`}, "127.0.0.1:1", "2001:db8::1"},
		{"peer", nil, "192.0.2.1:5555", "192.0.2.1"},
	}
	for _, tt := range tests {
		r := httptest.NewRequest("GET", "/", nil)
		r.RemoteAddr = tt.remote
		for k, v := range tt.headers {
			r.Header.Set(k, v)
		}
		if got, ok := ClientIP(r); !ok || got != tt.want {
			t.Errorf("%s: got %q %v, want %q", tt.name, got, ok, tt.want)
		}
	}
}

func TestCORS(t *testing.T) {
	h := CORS(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { w.WriteHeader(418) }))

	pre := httptest.NewRecorder()
	r := httptest.NewRequest("OPTIONS", "/api/v1/auth/login", nil)
	r.Header.Set("Origin", "https://example.com")
	r.Header.Set("Access-Control-Request-Method", "POST")
	h.ServeHTTP(pre, r)
	if pre.Code != 200 || pre.Header().Get("Access-Control-Allow-Origin") != "*" ||
		pre.Header().Get("Access-Control-Allow-Methods") != "*" || pre.Header().Get("Access-Control-Allow-Headers") != "*" {
		t.Errorf("preflight = %d %v", pre.Code, pre.Header())
	}

	normal := httptest.NewRecorder()
	h.ServeHTTP(normal, httptest.NewRequest("GET", "/", nil))
	if normal.Code != 418 || normal.Header().Get("Access-Control-Allow-Origin") != "*" {
		t.Errorf("normal = %d %v", normal.Code, normal.Header())
	}
}

func TestBare(t *testing.T) {
	mux := http.NewServeMux()
	mux.HandleFunc("GET /x", func(w http.ResponseWriter, r *http.Request) { w.Write([]byte("ok")) })
	h := Bare(mux)

	tests := []struct {
		method, path string
		status       int
		body, allow  string
	}{
		{"GET", "/x", 200, "ok", ""},
		{"GET", "/nope", 404, "", ""},
		{"DELETE", "/x", 405, "", "GET, HEAD"},
	}
	for _, tt := range tests {
		rec := httptest.NewRecorder()
		h.ServeHTTP(rec, httptest.NewRequest(tt.method, tt.path, nil))
		if rec.Code != tt.status || rec.Body.String() != tt.body || rec.Header().Get("Allow") != tt.allow {
			t.Errorf("%s %s = %d %q allow=%q", tt.method, tt.path, rec.Code, rec.Body.String(), rec.Header().Get("Allow"))
		}
	}
}
