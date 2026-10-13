//go:build sqlite

package app

import (
	"bytes"
	"encoding/base64"
	"encoding/json"
	"strings"
	"testing"
)

func avatarURL(mime string, magic []byte) string {
	return "data:" + mime + ";base64," + base64.StdEncoding.EncodeToString(append(append([]byte{}, magic...), bytes.Repeat([]byte{7}, 64)...))
}

// avatarOf reads "avatar" from a user object.
func avatarOf(t *testing.T, body string) any {
	t.Helper()
	var u map[string]any
	if err := json.Unmarshal([]byte(body), &u); err != nil {
		t.Fatalf("user %s: %v", body, err)
	}
	v, ok := u["avatar"]
	if !ok {
		t.Fatalf("no avatar field in %s", body)
	}
	return v
}

func TestAvatar(t *testing.T) {
	h := newHarness(t)
	webp := avatarURL("image/webp", []byte("RIFF\x24\x00\x00\x00WEBPVP8 "))
	png := avatarURL("image/png", []byte("\x89PNG\r\n\x1a\n"))

	// A second, ordinary account to show one person's picture never touches another's.
	h.expect("POST", "/api/v1/users", h.admin, `{"password":"password1","role":"user","firstName":"Ben","lastName":"Cruz"}`, 201, "")
	var login struct{ Token string }
	_ = json.Unmarshal([]byte(h.expect("POST", "/api/v1/auth/login", "", `{"identifier":"bcruz","password":"password1","role":"user"}`, 200, "")), &login)
	ben := login.Token

	if v := avatarOf(t, h.expect("GET", "/api/v1/auth/me", h.admin, "", 200, "")); v != nil {
		t.Fatalf("new account avatar = %v", v)
	}

	// Set.
	got := h.expect("PUT", "/api/v1/auth/me/avatar", h.admin, `{"avatar":"`+webp+`"}`, 200, "")
	if avatarOf(t, got) != webp || !strings.Contains(got, `"fullName":"Ada Admin","avatar":"data:image/webp;base64,`) {
		t.Fatalf("set = %s", got)
	}
	if avatarOf(t, h.expect("GET", "/api/v1/auth/me", h.admin, "", 200, "")) != webp {
		t.Error("GET /auth/me does not carry the picture")
	}
	var list []map[string]any
	_ = json.Unmarshal([]byte(h.expect("GET", "/api/v1/users", h.admin, "", 200, "")), &list)
	for _, u := range list {
		want := any(nil)
		if u["username"] == "admin" {
			want = webp
		}
		if u["avatar"] != want {
			t.Errorf("users list %s avatar = %v", u["username"], u["avatar"])
		}
	}
	if v := avatarOf(t, h.expect("GET", "/api/v1/auth/me", ben, "", 200, "")); v != nil {
		t.Errorf("another account's avatar = %v", v)
	}
	var login2 map[string]any
	_ = json.Unmarshal([]byte(h.expect("POST", "/api/v1/auth/login", "", `{"identifier":"admin","password":"admin-password","role":"admin"}`, 200, "")), &login2)
	if login2["user"].(map[string]any)["avatar"] != webp {
		t.Error("login response does not carry the picture")
	}

	// Replace.
	if avatarOf(t, h.expect("PUT", "/api/v1/auth/me/avatar", h.admin, `{"avatar":"`+png+`"}`, 200, "")) != png {
		t.Error("replace did not store the new picture")
	}

	// Refused, leaving the stored one alone.
	const msg = `{"error":"Profile picture must be a WebP, JPEG or PNG image under 100 KB"}`
	h.expect("PUT", "/api/v1/auth/me/avatar", h.admin, `{"avatar":"data:image/gif;base64,R0lGODlh"}`, 400, msg)
	h.expect("PUT", "/api/v1/auth/me/avatar", h.admin, `{"avatar":"`+avatarURL("image/png", []byte{0xFF, 0xD8, 0xFF})+`"}`, 400, msg)
	h.expect("PUT", "/api/v1/auth/me/avatar", h.admin, `{"avatar":"data:image/webp;base64,%%%"}`, 400, msg)
	tooBig := "data:image/jpeg;base64," + base64.StdEncoding.EncodeToString(append([]byte{0xFF, 0xD8, 0xFF}, make([]byte, 100<<10)...))
	h.expect("PUT", "/api/v1/auth/me/avatar", h.admin, `{"avatar":"`+tooBig+`"}`, 400, msg)
	huge := `{"avatar":"data:image/jpeg;base64,` + strings.Repeat("A", 250<<10) + `"}`
	h.expect("PUT", "/api/v1/auth/me/avatar", h.admin, huge, 413, "")
	h.expect("PUT", "/api/v1/auth/me/avatar", h.admin, `{}`, 422, "")
	h.expect("PUT", "/api/v1/auth/me/avatar", "", `{"avatar":"`+webp+`"}`, 401, "")
	h.expect("DELETE", "/api/v1/auth/me/avatar", "", "", 401, "")
	if avatarOf(t, h.expect("GET", "/api/v1/auth/me", h.admin, "", 200, "")) != png {
		t.Error("a refused upload changed the stored picture")
	}

	// Remove, twice: the second has nothing to remove and records nothing.
	if v := avatarOf(t, h.expect("DELETE", "/api/v1/auth/me/avatar", h.admin, "", 200, "")); v != nil {
		t.Errorf("after delete avatar = %v", v)
	}
	h.expect("DELETE", "/api/v1/auth/me/avatar", h.admin, "", 200, "")

	// Ben sets his own.
	h.expect("PUT", "/api/v1/auth/me/avatar", ben, `{"avatar":"`+webp+`"}`, 200, "")
	if v := avatarOf(t, h.expect("GET", "/api/v1/auth/me", h.admin, "", 200, "")); v != nil {
		t.Errorf("Ben's upload changed the admin's picture: %v", v)
	}

	raw := h.expect("GET", "/api/v1/audit?action=account.avatar", h.admin, "", 200, "")
	if strings.Contains(raw, "base64") || strings.Contains(raw, "data:image") {
		t.Fatalf("image data leaked into the audit log: %s", raw)
	}
	total, rows := h.auditPage("?action=account.avatar")
	want := []struct{ target, detail string }{
		{"Ben Cruz", `{"avatar":{"from":null,"to":"set"}}`},
		{"Ada Admin", `{"avatar":{"from":"set","to":null}}`},
		{"Ada Admin", `{"avatar":{"from":"set","to":"set"}}`},
		{"Ada Admin", `{"avatar":{"from":null,"to":"set"}}`},
	}
	if total != len(want) {
		t.Fatalf("account.avatar events = %d, want %d: %v", total, len(want), rows)
	}
	for i, w := range want {
		if rows[i]["target"] != w.target || rows[i]["actorName"] != w.target || detailJSON(t, rows[i]) != w.detail {
			t.Errorf("event %d = %v %s, want %s %s", i, rows[i]["target"], detailJSON(t, rows[i]), w.target, w.detail)
		}
	}
}
