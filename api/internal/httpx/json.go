package httpx

import (
	"bytes"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"mime"
	"net/http"
	"reflect"
	"strings"
)

// maxBody matches axum's default request body limit.
const maxBody = 2 << 20

// WriteJSON writes v as a compact JSON body, as serde_json would: no trailing newline
// and no HTML escaping. Use wire.Float and wire.Time in v for floats and timestamps.
func WriteJSON(w http.ResponseWriter, status int, v any) {
	var buf bytes.Buffer
	enc := json.NewEncoder(&buf)
	enc.SetEscapeHTML(false)
	if err := enc.Encode(v); err != nil {
		// Only reachable with a type that cannot be encoded: a programming error.
		http.Error(w, "could not encode response", http.StatusInternalServerError)
		return
	}
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	_, _ = w.Write(bytes.TrimSuffix(buf.Bytes(), []byte("\n")))
}

// NoContent writes an empty response with status, for 201s and 204s without a body.
func NoContent(w http.ResponseWriter, status int) {
	w.WriteHeader(status)
}

// DecodeJSON reads the request body into dst, a pointer to a struct, rejecting the
// same requests axum's Json extractor rejected and with the same status codes:
//
//   - 415 when Content-Type is not application/json (or application/*+json);
//   - 413 when the body exceeds 2 MiB;
//   - 400 when the body is not JSON at all;
//   - 422 when it is JSON of the wrong shape: wrong types, or a missing field.
//
// A field is required when its struct tag says `required:"true"`; a required field
// that is absent or null is a 422, as serde treats a non-Option field. Leave optional
// fields as pointers so absent and null both decode to nil, as Option did.
func DecodeJSON(r *http.Request, dst any) error {
	if !isJSONContentType(r.Header.Get("Content-Type")) {
		return rejection(http.StatusUnsupportedMediaType, "Expected request with `Content-Type: application/json`")
	}

	body, err := io.ReadAll(http.MaxBytesReader(nil, r.Body, maxBody))
	if err != nil {
		var tooLarge *http.MaxBytesError
		if errors.As(err, &tooLarge) {
			return rejection(http.StatusRequestEntityTooLarge, "Failed to buffer the request body: length limit exceeded")
		}
		return rejection(http.StatusBadRequest, "Failed to buffer the request body: "+err.Error())
	}

	if err := json.Unmarshal(body, dst); err != nil {
		var syntax *json.SyntaxError
		if errors.As(err, &syntax) {
			return rejection(http.StatusBadRequest, "Failed to parse the request body as JSON: "+err.Error())
		}
		return dataError(describeDecodeError(err))
	}

	return checkRequired(body, dst)
}

func dataError(msg string) *Error {
	return rejection(http.StatusUnprocessableEntity, "Failed to deserialize the JSON body into the target type: "+msg)
}

func describeDecodeError(err error) string {
	var typeErr *json.UnmarshalTypeError
	if errors.As(err, &typeErr) && typeErr.Field != "" {
		return fmt.Sprintf("%s: invalid type: %s, expected %s", typeErr.Field, typeErr.Value, typeErr.Type)
	}
	if errors.As(err, &typeErr) {
		return fmt.Sprintf("invalid type: %s, expected %s", typeErr.Value, typeErr.Type)
	}
	return err.Error()
}

func isJSONContentType(header string) bool {
	if header == "" {
		return false
	}
	mediaType, _, err := mime.ParseMediaType(header)
	if err != nil {
		return false
	}
	kind, sub, ok := strings.Cut(mediaType, "/")
	return ok && kind == "application" && (sub == "json" || strings.HasSuffix(sub, "+json"))
}

// checkRequired enforces `required:"true"` fields. Keys are matched exactly, as serde
// does, rather than with encoding/json's case-insensitive matching.
func checkRequired(body []byte, dst any) error {
	t := reflect.TypeOf(dst)
	for t.Kind() == reflect.Pointer {
		t = t.Elem()
	}
	if t.Kind() != reflect.Struct {
		return nil
	}

	var raw map[string]json.RawMessage
	if err := json.Unmarshal(body, &raw); err != nil {
		// The body decoded into a struct, so it is an object or null.
		raw = nil
	}
	if raw == nil {
		return dataError(fmt.Sprintf("invalid type: null, expected struct %s", t.Name()))
	}

	for i := range t.NumField() {
		field := t.Field(i)
		if field.Tag.Get("required") != "true" {
			continue
		}
		name, _, _ := strings.Cut(field.Tag.Get("json"), ",")
		if name == "" {
			name = field.Name
		}
		value, present := raw[name]
		if !present {
			return dataError(fmt.Sprintf("missing field `%s`", name))
		}
		if string(bytes.TrimSpace(value)) == "null" {
			return dataError(fmt.Sprintf("%s: invalid type: null, expected %s", name, field.Type))
		}
	}
	return nil
}
