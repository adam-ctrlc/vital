// Package httpx is the HTTP plumbing every route group shares: typed API errors and
// their one conversion to a response, JSON in and out with the Rust API's rejection
// rules, query and path parsing, paging, CORS, logging and rate limiting.
package httpx

import (
	"errors"
	"fmt"
	"log/slog"
	"net/http"
	"unicode"
	"unicode/utf8"

	"github.com/adam-ctrlc/vital/api/internal/db"
)

// Error is an API error: a status and the message the client renders.
//
// Message is written lowercase so it composes into logs and wrapped errors; the JSON
// body sentence-cases it, exactly as the Rust AppError did. Cause, when set, is logged
// for 5xx responses and never sent to the client.
type Error struct {
	Status  int
	Message string
	Cause   error
	// Plain marks a request rejection (malformed JSON, bad query string, bad path
	// parameter). Axum answered those in text/plain rather than {"error": ...}, and
	// the status codes and bodies are kept the same.
	Plain bool
}

func (e *Error) Error() string {
	if e.Cause != nil {
		return e.Message + ": " + e.Cause.Error()
	}
	return e.Message
}

func (e *Error) Unwrap() error { return e.Cause }

// With returns a copy of e carrying cause, for logging a fixed error's reason:
//
//	return httpx.ErrPasswordHash.With(err)
func (e *Error) With(cause error) *Error {
	c := *e
	c.Cause = cause
	return &c
}

// The fixed errors, with the Rust AppError's status and text.
var (
	ErrInvalidCredentials = &Error{Status: http.StatusUnauthorized, Message: "invalid credentials"}
	ErrUnauthorized       = &Error{Status: http.StatusUnauthorized, Message: "missing or invalid token"}
	ErrForbidden          = &Error{Status: http.StatusForbidden, Message: "admin access required"}
	ErrPendingApproval    = &Error{Status: http.StatusForbidden, Message: "your account is waiting for an admin to approve it"}
	ErrNotFound           = &Error{Status: http.StatusNotFound, Message: "not found"}
	ErrPasswordHash       = &Error{Status: http.StatusInternalServerError, Message: "could not hash password"}
	ErrToken              = &Error{Status: http.StatusInternalServerError, Message: "could not create token"}
)

// BadRequest is a 400 with a message for the user. Write it lowercase unless the Rust
// original was capitalised; the response sentence-cases it either way.
func BadRequest(format string, args ...any) *Error {
	return &Error{Status: http.StatusBadRequest, Message: fmt.Sprintf(format, args...)}
}

// TooManyRequests is the rate limiter's 429.
func TooManyRequests(waitSeconds uint64) *Error {
	return &Error{Status: http.StatusTooManyRequests, Message: fmt.Sprintf("too many attempts, try again in %ds", waitSeconds)}
}

// Upstream is a 502: the database answered with something it should never hold, such
// as an unparseable stored id or a missing settings row. The detail is part of the
// message, as it was in Rust.
func Upstream(format string, args ...any) *Error {
	return &Error{Status: http.StatusBadGateway, Message: "upstream error: " + fmt.Sprintf(format, args...)}
}

// Config is a 500 for a deployment problem, such as an unset environment variable.
func Config(err error) *Error {
	return &Error{Status: http.StatusInternalServerError, Message: "configuration error: " + err.Error(), Cause: err}
}

// Internal is a 500 that reads "Database error" to the client, which is what every
// unexpected failure was in the Rust API. Handlers rarely need it: returning any
// non-*Error error has the same effect.
func Internal(err error) *Error {
	return &Error{Status: http.StatusInternalServerError, Message: "database error", Cause: err}
}

// rejection builds a plain-text request rejection.
func rejection(status int, msg string) *Error {
	return &Error{Status: status, Message: msg, Plain: true}
}

// toAPIError maps any error to the response it produces. Unknown errors are database
// failures (that is all a store returns), except a unique violation, which is the
// caller's conflict rather than a server fault.
func toAPIError(err error) *Error {
	var apiErr *Error
	if errors.As(err, &apiErr) {
		return apiErr
	}
	if db.IsUniqueViolation(err) {
		return &Error{Status: http.StatusConflict, Message: "already exists", Cause: err}
	}
	return Internal(err)
}

// WriteError sends err as the response. Every error response goes through here.
func WriteError(w http.ResponseWriter, r *http.Request, err error) {
	apiErr := toAPIError(err)

	if apiErr.Status >= http.StatusInternalServerError {
		slog.ErrorContext(r.Context(), "request failed",
			"method", r.Method, "path", r.URL.Path, "status", apiErr.Status, "error", err)
	}

	if apiErr.Plain {
		w.Header().Set("Content-Type", "text/plain; charset=utf-8")
		w.WriteHeader(apiErr.Status)
		_, _ = w.Write([]byte(apiErr.Message))
		return
	}

	WriteJSON(w, apiErr.Status, map[string]string{"error": SentenceCase(apiErr.Message)})
}

// SentenceCase uppercases the first character only. Messages stay lowercase so they
// compose; only the JSON the client renders verbatim is sentence cased.
func SentenceCase(s string) string {
	r, size := utf8.DecodeRuneInString(s)
	if size == 0 {
		return s
	}
	return string(unicode.ToUpper(r)) + s[size:]
}

// HandlerFunc is an http.Handler that returns its error instead of writing it, so
// every handler's failures reach the one place that turns them into responses.
type HandlerFunc func(w http.ResponseWriter, r *http.Request) error

func (f HandlerFunc) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	if err := f(w, r); err != nil {
		WriteError(w, r, err)
	}
}
