package readings

import (
	"errors"
	"net/http"
	"testing"

	"github.com/adam-ctrlc/vital/api/internal/httpx"
)

func ptr[T any](v T) *T { return &v }

// wantBadRequest fails unless err is a 400 carrying msg (when msg is not empty).
func wantBadRequest(t *testing.T, err error, msg string) {
	t.Helper()
	var apiErr *httpx.Error
	if !errors.As(err, &apiErr) {
		t.Fatalf("got %v, want a 400", err)
	}
	if apiErr.Status != http.StatusBadRequest {
		t.Fatalf("status = %d, want 400", apiErr.Status)
	}
	if msg != "" && apiErr.Message != msg {
		t.Fatalf("message = %q, want %q", apiErr.Message, msg)
	}
}
