package notifications

import (
	"errors"
	"net/http/httptest"
	"reflect"
	"strings"
	"testing"

	"github.com/adam-ctrlc/vital/api/internal/httpx"
)

func ptr[T any](v T) *T { return &v }

// Cases mirror what serde_json and axum's Json extractor did with the Rust
// RegisterToken struct.
func TestRegisterTokenDecode(t *testing.T) {
	tests := []struct {
		name   string
		body   string
		want   RegisterToken
		status int // 0 for success
	}{
		{name: "token only", body: `{"token":"ExponentPushToken[a]"}`, want: RegisterToken{Token: "ExponentPushToken[a]"}},
		{
			name: "every field",
			body: `{"token":"t","platform":"android","channelId":"alarm-siren"}`,
			want: RegisterToken{Token: "t", Platform: ptr("android"), ChannelID: ptr("alarm-siren")},
		},
		{name: "nulls are absent", body: `{"token":"t","platform":null,"channelId":null}`, want: RegisterToken{Token: "t"}},
		{name: "unknown keys ignored", body: `{"token":"t","extra":{"x":[1,2]}}`, want: RegisterToken{Token: "t"}},
		{name: "blank token decodes, validation refuses it later", body: `{"token":"  "}`, want: RegisterToken{Token: "  "}},
		{name: "required key is case sensitive", body: `{"TOKEN":"a"}`, status: 422},
		{name: "missing token", body: `{}`, status: 422},
		{name: "null token", body: `{"token":null}`, status: 422},
		{name: "numeric token", body: `{"token":5}`, status: 422},
		{name: "numeric platform", body: `{"token":"a","channelId":null,"platform":1}`, status: 422},
		{name: "null body", body: `null`, status: 422},
		{name: "array body", body: `[]`, status: 422},
		{name: "empty body", body: ``, status: 400},
		{name: "malformed", body: `{"token":`, status: 400},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			r := httptest.NewRequest("POST", "/", strings.NewReader(tt.body))
			r.Header.Set("Content-Type", "application/json")
			var got RegisterToken
			err := httpx.DecodeJSON(r, &got)

			if tt.status != 0 {
				var apiErr *httpx.Error
				if !errors.As(err, &apiErr) || apiErr.Status != tt.status || !apiErr.Plain {
					t.Fatalf("err = %v, want plain %d", err, tt.status)
				}
				return
			}
			if err != nil {
				t.Fatal(err)
			}
			if !reflect.DeepEqual(got, tt.want) {
				t.Errorf("got %+v, want %+v", got, tt.want)
			}
		})
	}
}

func TestRegistration(t *testing.T) {
	tests := []struct {
		name    string
		in      RegisterToken
		want    Registration
		wantErr error
	}{
		{
			name: "defaults",
			in:   RegisterToken{Token: "t"},
			want: Registration{Token: "t", Platform: "unknown"},
		},
		{
			name: "token and channel trimmed, platform kept as sent",
			in:   RegisterToken{Token: "  t\n", Platform: ptr(" ios "), ChannelID: ptr("  alarm  ")},
			want: Registration{Token: "t", Platform: " ios ", ChannelID: ptr("alarm")},
		},
		{
			name: "empty platform is stored empty, not defaulted",
			in:   RegisterToken{Token: "t", Platform: ptr("")},
			want: Registration{Token: "t", Platform: ""},
		},
		{
			name: "blank channel is no channel",
			in:   RegisterToken{Token: "t", ChannelID: ptr("   ")},
			want: Registration{Token: "t", Platform: "unknown"},
		},
		{name: "empty token", in: RegisterToken{Token: ""}, wantErr: ErrTokenRequired},
		{name: "blank token", in: RegisterToken{Token: " \t "}, wantErr: ErrTokenRequired},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			got, err := tt.in.Registration()
			if !errors.Is(err, tt.wantErr) {
				t.Fatalf("err = %v, want %v", err, tt.wantErr)
			}
			if !reflect.DeepEqual(got, tt.want) {
				t.Errorf("got %+v, want %+v", got, tt.want)
			}
		})
	}
}

func TestUnregisterToken(t *testing.T) {
	tests := []struct{ in, want string }{
		{"t", "t"},
		{"  t  ", "t"},
		{"   ", ""}, // not refused: deletes nothing and still succeeds
	}
	for _, tt := range tests {
		if got := (RegisterToken{Token: tt.in}).UnregisterToken(); got != tt.want {
			t.Errorf("UnregisterToken(%q) = %q, want %q", tt.in, got, tt.want)
		}
	}
}
