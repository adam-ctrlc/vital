package account

import (
	"bytes"
	"encoding/base64"
	"net/http"
	"strings"

	"github.com/adam-ctrlc/vital/api/internal/audit"
	"github.com/adam-ctrlc/vital/api/internal/auth"
	"github.com/adam-ctrlc/vital/api/internal/httpx"
)

const (
	// maxAvatarBytes bounds the decoded image. The app sends about 10-20 KB.
	maxAvatarBytes = 100 << 10
	// maxAvatarBody refuses an oversized upload before it is decoded.
	maxAvatarBody = 200 << 10

	avatarMessage = "Profile picture must be a WebP, JPEG or PNG image under 100 KB"
)

var avatarKinds = []struct {
	prefix string
	magic  func([]byte) bool
}{
	{"data:image/webp;base64,", func(b []byte) bool {
		return len(b) >= 12 && string(b[:4]) == "RIFF" && string(b[8:12]) == "WEBP"
	}},
	{"data:image/jpeg;base64,", func(b []byte) bool { return bytes.HasPrefix(b, []byte{0xFF, 0xD8, 0xFF}) }},
	{"data:image/png;base64,", func(b []byte) bool { return bytes.HasPrefix(b, []byte("\x89PNG\r\n\x1a\n")) }},
}

// validAvatar reports whether s is a data URL of a WebP, JPEG or PNG under the size
// limit, checked against the image's own first bytes rather than trusting the prefix.
func validAvatar(s string) bool {
	for _, kind := range avatarKinds {
		payload, ok := strings.CutPrefix(s, kind.prefix)
		if !ok {
			continue
		}
		b, err := base64.StdEncoding.DecodeString(payload)
		return err == nil && len(b) <= maxAvatarBytes && kind.magic(b)
	}
	return false
}

type avatarRequest struct {
	Avatar string `json:"avatar" required:"true"`
}

// setAvatar: PUT /auth/me/avatar -> Profile.
func (h *Handler) setAvatar(w http.ResponseWriter, r *http.Request) error {
	r.Body = http.MaxBytesReader(w, r.Body, maxAvatarBody)
	var body avatarRequest
	if err := httpx.DecodeJSON(r, &body); err != nil {
		return err
	}
	if !validAvatar(body.Avatar) {
		return httpx.BadRequest(avatarMessage)
	}
	return h.saveAvatar(w, r, &body.Avatar)
}

// removeAvatar: DELETE /auth/me/avatar -> Profile.
func (h *Handler) removeAvatar(w http.ResponseWriter, r *http.Request) error {
	return h.saveAvatar(w, r, nil)
}

func (h *Handler) saveAvatar(w http.ResponseWriter, r *http.Request, avatar *string) error {
	ctx := r.Context()
	caller, _ := auth.IdentityFrom(ctx)
	current, err := h.store.byID(ctx, caller.ID)
	if err != nil {
		return err
	}
	updated, err := h.store.setAvatar(ctx, caller.ID, avatar)
	if err != nil {
		return err
	}
	role, err := updated.parsedRole()
	if err != nil {
		return err
	}

	profile := updated.profile(role)
	// The audit records that the picture changed, never the image itself.
	if current.avatar != nil || avatar != nil {
		h.audit.Record(ctx, caller.ID, audit.AccountAvatar, profile.FullName,
			audit.Changes{"avatar": {From: setOrNull(current.avatar), To: setOrNull(avatar)}})
	}
	httpx.WriteJSON(w, http.StatusOK, profile)
	return nil
}

func setOrNull(avatar *string) any {
	if avatar == nil {
		return nil
	}
	return "set"
}
