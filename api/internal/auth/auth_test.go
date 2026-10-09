package auth

import (
	"encoding/base64"
	"net/http"
	"net/http/httptest"
	"regexp"
	"strings"
	"testing"
	"time"

	"github.com/google/uuid"
)

// Produced by the Rust API's own code path (jsonwebtoken 10.4.0, Header::default(),
// Claims{sub, role: Admin, exp: 4102444800}) with secret "test-secret".
const rustToken = "eyJ0eXAiOiJKV1QiLCJhbGciOiJIUzI1NiJ9." +
	"eyJzdWIiOiIzZjJiOGMxZS00ZDVhLTRiNmMtOWU3Zi0wYTFiMmMzZDRlNWYiLCJyb2xlIjoiYWRtaW4iLCJleHAiOjQxMDI0NDQ4MDB9." +
	"e9GU0SjoREBQCeEYwLyAG4VHsMnUXABgbmd62NUmCng"

// Produced by argon2 0.5.3's Argon2::default().hash_password("correct horse battery")
// with the salt b"fixedsalt1234567".
const rustHash = "$argon2id$v=19$m=19456,t=2,p=1$Zml4ZWRzYWx0MTIzNDU2Nw$B8rWtE9PzAnFs0NhKWut75dQluDIhXCMswQSKboG6Co"

var (
	secret   = []byte("test-secret")
	fixedSub = uuid.MustParse("3f2b8c1e-4d5a-4b6c-9e7f-0a1b2c3d4e5f")
	now      = time.Unix(1_800_000_000, 0)
)

func TestRustTokenVerifies(t *testing.T) {
	c, err := DecodeToken(secret, rustToken, now)
	if err != nil {
		t.Fatal(err)
	}
	if c.Sub != fixedSub || c.Role != Admin || c.Exp != 4102444800 {
		t.Errorf("claims = %+v", c)
	}
}

func TestTokenIsByteIdenticalToRust(t *testing.T) {
	got, err := encodeClaims(secret, Claims{Sub: fixedSub, Role: Admin, Exp: 4102444800})
	if err != nil {
		t.Fatal(err)
	}
	if got != rustToken {
		t.Errorf("token differs from Rust's:\n got %s\nwant %s", got, rustToken)
	}
}

func TestTokenRoundTrip(t *testing.T) {
	for _, role := range []Role{Admin, User} {
		tok, err := EncodeToken(secret, fixedSub, role, now)
		if err != nil {
			t.Fatal(err)
		}
		c, err := DecodeToken(secret, tok, now)
		if err != nil {
			t.Fatal(err)
		}
		if c.Sub != fixedSub || c.Role != role || c.Exp != now.Add(12*time.Hour).Unix() {
			t.Errorf("claims = %+v", c)
		}
	}
}

func forge(header, payload string, key []byte) string {
	h := base64.RawURLEncoding.EncodeToString([]byte(header))
	p := base64.RawURLEncoding.EncodeToString([]byte(payload))
	return h + "." + p + "." + sign(key, h+"."+p)
}

func TestTokenRejections(t *testing.T) {
	hs := `{"typ":"JWT","alg":"HS256"}`
	sub := fixedSub.String()

	tests := []struct {
		name  string
		token string
		ok    bool
	}{
		{"valid", forge(hs, `{"sub":"`+sub+`","role":"user","exp":1800000100}`, secret), true},
		{"expired within leeway", forge(hs, `{"sub":"`+sub+`","role":"user","exp":1799999950}`, secret), true},
		{"expired beyond leeway", forge(hs, `{"sub":"`+sub+`","role":"user","exp":1799999939}`, secret), false},
		{"wrong secret", forge(hs, `{"sub":"`+sub+`","role":"user","exp":1800000100}`, []byte("other")), false},
		{"alg none", forge(`{"alg":"none"}`, `{"sub":"`+sub+`","role":"user","exp":1800000100}`, secret), false},
		{"alg HS512 header", forge(`{"alg":"HS512"}`, `{"sub":"`+sub+`","role":"user","exp":1800000100}`, secret), false},
		{"missing exp", forge(hs, `{"sub":"`+sub+`","role":"user"}`, secret), false},
		{"quoted exp", forge(hs, `{"sub":"`+sub+`","role":"user","exp":"1800000100"}`, secret), false},
		{"has aud", forge(hs, `{"sub":"`+sub+`","role":"user","exp":1800000100,"aud":"x"}`, secret), false},
		{"bad role", forge(hs, `{"sub":"`+sub+`","role":"root","exp":1800000100}`, secret), false},
		{"bad sub", forge(hs, `{"sub":"42","role":"user","exp":1800000100}`, secret), false},
		{"two parts", "a.b", false},
		{"garbage", "not a token", false},
	}
	for _, tt := range tests {
		_, err := DecodeToken(secret, tt.token, now)
		if (err == nil) != tt.ok {
			t.Errorf("%s: err = %v, want ok=%v", tt.name, err, tt.ok)
		}
	}
}

func TestRustPasswordHashVerifies(t *testing.T) {
	if !VerifyPassword("correct horse battery", rustHash) {
		t.Fatal("Rust hash did not verify")
	}
	if VerifyPassword("wrong horse battery", rustHash) {
		t.Fatal("wrong password verified")
	}
}

func TestHashPasswordFormat(t *testing.T) {
	h, err := HashPassword("s3cret-pass")
	if err != nil {
		t.Fatal(err)
	}
	// Same shape the Rust crate writes: 22 char salt, 43 char hash.
	if !regexp.MustCompile(`^\$argon2id\$v=19\$m=19456,t=2,p=1\$[A-Za-z0-9+/]{22}\$[A-Za-z0-9+/]{43}$`).MatchString(h) {
		t.Fatalf("hash = %s", h)
	}
	if !VerifyPassword("s3cret-pass", h) || VerifyPassword("s3cret-pasS", h) {
		t.Fatal("round trip failed")
	}
}

func TestMalformedHashesDoNotVerify(t *testing.T) {
	for _, h := range []string{
		"",
		"plaintext",
		"$argon2id$v=19$m=19456,t=2,p=1$Zml4ZWRzYWx0MTIzNDU2Nw",
		"$argon2id$v=16$m=19456,t=2,p=1$Zml4ZWRzYWx0MTIzNDU2Nw$B8rWtE9PzAnFs0NhKWut75dQluDIhXCMswQSKboG6Co",
		"$argon2d$v=19$m=19456,t=2,p=1$Zml4ZWRzYWx0MTIzNDU2Nw$B8rWtE9PzAnFs0NhKWut75dQluDIhXCMswQSKboG6Co",
		"$argon2id$v=19$m=19456,t=0,p=1$Zml4ZWRzYWx0MTIzNDU2Nw$B8rWtE9PzAnFs0NhKWut75dQluDIhXCMswQSKboG6Co",
		"$bcrypt$whatever",
	} {
		if VerifyPassword("correct horse battery", h) {
			t.Errorf("verified against %q", h)
		}
	}
}

func TestVerifyDummyDoesNotPanic(t *testing.T) {
	VerifyDummy("anything")
	VerifyDummy("anything")
}

func TestGuard(t *testing.T) {
	g := NewGuard("test-secret", "dev-key")
	g.now = func() time.Time { return now }
	userTok, _ := g.Issue(fixedSub, User)
	adminTok, _ := g.Issue(fixedSub, Admin)

	ok := http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		id, found := IdentityFrom(r.Context())
		if !found || id.ID != fixedSub {
			w.WriteHeader(500)
			return
		}
		w.WriteHeader(204)
	})

	tests := []struct {
		name   string
		mw     func(http.Handler) http.Handler
		header string
		value  string
		want   int
	}{
		{"user ok", g.User, "Authorization", "Bearer " + userTok, 204},
		{"user ok, padded token", g.User, "Authorization", "Bearer  " + userTok + " ", 204},
		{"user no header", g.User, "", "", 401},
		{"user lowercase scheme", g.User, "Authorization", "bearer " + userTok, 401},
		{"user bad token", g.User, "Authorization", "Bearer x.y.z", 401},
		{"admin ok", g.Admin, "Authorization", "Bearer " + adminTok, 204},
		{"admin as user", g.Admin, "Authorization", "Bearer " + userTok, 403},
		{"admin no token", g.Admin, "", "", 401},
	}
	for _, tt := range tests {
		r := httptest.NewRequest("GET", "/", nil)
		if tt.header != "" {
			r.Header.Set(tt.header, tt.value)
		}
		rec := httptest.NewRecorder()
		tt.mw(ok).ServeHTTP(rec, r)
		if rec.Code != tt.want {
			t.Errorf("%s: status %d, want %d (%s)", tt.name, rec.Code, tt.want, rec.Body.String())
		}
	}
}

func TestDeviceKey(t *testing.T) {
	tests := []struct {
		name       string
		configured string
		header     *string
		want       bool
	}{
		{"match", "dev-key", ptr("dev-key"), true},
		{"mismatch", "dev-key", ptr("dev-kez"), false},
		{"prefix", "dev-key", ptr("dev"), false},
		{"missing header", "dev-key", nil, false},
		{"unset key, empty header", "", ptr(""), false},
		{"unset key, any header", "", ptr("anything"), false},
	}
	for _, tt := range tests {
		g := NewGuard("s", tt.configured)
		r := httptest.NewRequest("POST", "/", nil)
		if tt.header != nil {
			r.Header.Set("x-device-key", *tt.header)
		}
		if got := g.DeviceAuthorized(r); got != tt.want {
			t.Errorf("%s: got %v, want %v", tt.name, got, tt.want)
		}
		rec := httptest.NewRecorder()
		g.Device(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { w.WriteHeader(204) })).ServeHTTP(rec, r)
		if want := map[bool]int{true: 204, false: 401}[tt.want]; rec.Code != want {
			t.Errorf("%s: middleware status %d, want %d", tt.name, rec.Code, want)
		}
	}
}

func ptr(s string) *string { return &s }

func TestRoleJSON(t *testing.T) {
	var r Role
	if err := r.UnmarshalJSON([]byte(`"admin"`)); err != nil || r != Admin {
		t.Errorf("admin: %v %v", r, err)
	}
	if err := r.UnmarshalJSON([]byte(`"nurse"`)); err == nil || !strings.Contains(err.Error(), "unknown variant `nurse`") {
		t.Errorf("nurse: %v", err)
	}
	if Admin.PortalHint() != "you're an admin. Choose Admin above, then sign in" {
		t.Error(Admin.PortalHint())
	}
}
