package notifications

import (
	"strings"

	"github.com/adam-ctrlc/vital/api/internal/httpx"
)

// DefaultPlatform is stored when a device does not say which platform it is.
const DefaultPlatform = "unknown"

// ErrTokenRequired is a register request whose token is blank: a 400 reading
// "Push token is required", capitalised in the Rust source too.
var ErrTokenRequired = httpx.BadRequest("Push token is required")

// RegisterToken is the body of both register and unregister. token is required (absent
// or null is a 422); platform and channelId may be absent or null.
type RegisterToken struct {
	Token    string  `json:"token" required:"true"`
	Platform *string `json:"platform"`
	// ChannelID is the Android notification channel the device wants alerts on,
	// which is what decides the tone. Absent from older clients and from iOS.
	ChannelID *string `json:"channelId"`
}

// Registration is a device as stored in push_tokens.
type Registration struct {
	// Token is trimmed.
	Token string
	// Platform is as sent (not trimmed), or DefaultPlatform when absent or null. An
	// explicit "" is stored as "".
	Platform string
	// ChannelID is trimmed, and nil when absent or blank, so Expo falls back to the
	// app's default channel rather than being sent an empty one.
	ChannelID *string
}

// Registration validates a register request and normalises it for storage.
// A blank token is ErrTokenRequired.
func (r RegisterToken) Registration() (Registration, error) {
	token := strings.TrimSpace(r.Token)
	if token == "" {
		return Registration{}, ErrTokenRequired
	}

	reg := Registration{Token: token, Platform: DefaultPlatform}
	if r.Platform != nil {
		reg.Platform = *r.Platform
	}
	if r.ChannelID != nil {
		if c := strings.TrimSpace(*r.ChannelID); c != "" {
			reg.ChannelID = &c
		}
	}
	return reg, nil
}

// UnregisterToken is the token an unregister request deletes: trimmed, and not
// validated. A blank or unknown token deletes nothing and still succeeds, and only
// the caller's own registration of it is removed.
func (r RegisterToken) UnregisterToken() string {
	return strings.TrimSpace(r.Token)
}
