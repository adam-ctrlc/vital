package readings

import "github.com/adam-ctrlc/vital/api/internal/httpx"

// Status is how a reading's load compares with the alarm threshold.
type Status string

// The two statuses a reading can carry. The database's check constraint allows only these.
const (
	StatusNormal   Status = "normal"
	StatusOverload Status = "overload"
)

// ParseStatus reads a status from user input. Case-sensitive, as the Rust FromStr was.
func ParseStatus(value string) (Status, error) {
	switch Status(value) {
	case StatusNormal, StatusOverload:
		return Status(value), nil
	default:
		return "", httpx.BadRequest("invalid status: %s", value)
	}
}
