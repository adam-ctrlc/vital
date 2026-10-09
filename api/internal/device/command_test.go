package device

import (
	"encoding/json"
	"errors"
	"net/http"
	"testing"
)

func TestParseCommand(t *testing.T) {
	tests := []struct {
		in      string
		want    Command
		wantErr bool
	}{
		{in: "open", want: CommandOpen},
		{in: "close", want: CommandClose},
		// The board matches exactly; anything it would ignore is refused here.
		{in: "Open", wantErr: true},
		{in: "CLOSE", wantErr: true},
		{in: " open", wantErr: true},
		{in: "", wantErr: true},
		{in: "toggle", wantErr: true},
	}
	for _, tt := range tests {
		t.Run(tt.in, func(t *testing.T) {
			got, err := ParseCommand(tt.in)
			if tt.wantErr {
				if !errors.Is(err, ErrInvalidCommand) {
					t.Fatalf("err = %v, want ErrInvalidCommand", err)
				}
				return
			}
			if err != nil || got != tt.want {
				t.Fatalf("ParseCommand(%q) = %q, %v; want %q", tt.in, got, err, tt.want)
			}
		})
	}
}

func TestInvalidCommandMessageMatchesRust(t *testing.T) {
	if got, want := ErrInvalidCommand.Error(), "relay command must be open or close"; got != want {
		t.Errorf("message = %q, want %q", got, want)
	}
}

func TestCommandMarshalJSON(t *testing.T) {
	tests := []struct {
		cmd  Command
		want string
	}{
		{CommandNone, `null`},
		{CommandOpen, `"open"`},
		{CommandClose, `"close"`},
	}
	for _, tt := range tests {
		got, err := json.Marshal(tt.cmd)
		if err != nil || string(got) != tt.want {
			t.Errorf("Marshal(%q) = %s, %v; want %s", tt.cmd, got, err, tt.want)
		}
	}
}

func TestDecodeRelayRequest(t *testing.T) {
	tests := []struct {
		name       string
		body       string
		wantStatus int // from decoding
		want       Command
		wantErr    bool // from Validate (a 400)
	}{
		{name: "open", body: `{"command":"open"}`, want: CommandOpen},
		{name: "close", body: `{"command":"close"}`, want: CommandClose},
		{name: "unknown word passes decoding and fails validation", body: `{"command":"reset"}`, wantErr: true},
		{name: "empty string fails validation", body: `{"command":""}`, wantErr: true},
		{name: "missing command", body: `{}`, wantStatus: http.StatusUnprocessableEntity},
		{name: "null command", body: `{"command":null}`, wantStatus: http.StatusUnprocessableEntity},
		{name: "command as number", body: `{"command":1}`, wantStatus: http.StatusUnprocessableEntity},
		{name: "null body", body: `null`, wantStatus: http.StatusUnprocessableEntity},
		{name: "not JSON", body: `command=open`, wantStatus: http.StatusBadRequest},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			var req RelayRequest
			if status := decode(t, tt.body, &req); status != tt.wantStatus {
				t.Fatalf("decode status = %d, want %d", status, tt.wantStatus)
			}
			if tt.wantStatus != 0 {
				return
			}
			got, err := req.Validate()
			if tt.wantErr {
				if !errors.Is(err, ErrInvalidCommand) {
					t.Fatalf("Validate err = %v, want ErrInvalidCommand", err)
				}
				return
			}
			if err != nil || got != tt.want {
				t.Fatalf("Validate() = %q, %v; want %q", got, err, tt.want)
			}
		})
	}
}

func TestAcceptedJSON(t *testing.T) {
	got, err := json.Marshal(Accepted{Accepted: true})
	if err != nil || string(got) != `{"accepted":true}` {
		t.Errorf("Marshal = %s, %v", got, err)
	}
}
