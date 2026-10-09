package device

import (
	"encoding/json"
	"errors"
)

// Command is what an operator has asked the relay to do. The zero value means
// nothing is pending.
//
// The firmware compares the string against exactly "open" and "close" and leaves
// the contacts alone for anything else, so these spellings are fixed.
type Command string

// The relay commands the board understands.
const (
	CommandNone  Command = ""
	CommandOpen  Command = "open"
	CommandClose Command = "close"
)

// ErrInvalidCommand is returned for a relay request that is neither "open" nor
// "close". The Rust API answered it with a 400 carrying exactly this text, so
// it is returned unwrapped for the handler to pass through.
var ErrInvalidCommand = errors.New("relay command must be open or close")

// ParseCommand accepts exactly "open" or "close". Matching is case sensitive, as
// it is on the board: "Open" would be queued, handed over, and silently ignored.
func ParseCommand(s string) (Command, error) {
	switch c := Command(s); c {
	case CommandOpen, CommandClose:
		return c, nil
	default:
		return CommandNone, ErrInvalidCommand
	}
}

// MarshalJSON writes the command as a string, or null when nothing is pending.
// The Rust API sent Option<String> without skipping None, so the key is always
// present; the firmware reads null as "no command".
func (c Command) MarshalJSON() ([]byte, error) {
	if c == CommandNone {
		return []byte("null"), nil
	}
	return json.Marshal(string(c))
}

// RelayRequest is the body of POST /device/relay.
//
// The required tag is httpx.DecodeJSON's: an absent or null command is a 422, as
// serde treated the non-Option field. An unknown word gets past decoding and is
// refused by Validate with a 400.
type RelayRequest struct {
	Command string `json:"command" required:"true"`
}

// Validate returns the requested command, or ErrInvalidCommand.
func (r RelayRequest) Validate() (Command, error) {
	return ParseCommand(r.Command)
}

// Accepted is the response to a queued relay command: {"accepted": true}. It means
// the command is waiting for the board, not that the contacts have moved.
type Accepted struct {
	Accepted bool `json:"accepted"`
}
