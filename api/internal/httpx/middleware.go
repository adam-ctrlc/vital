package httpx

import (
	"log/slog"
	"net/http"
	"time"
)

// CORS allows any origin, method and header, as tower-http's CorsLayer with Any did:
// every OPTIONS request is answered here as a preflight (200, empty body) without
// reaching a route, and every other response carries Access-Control-Allow-Origin: *.
func CORS(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		h := w.Header()
		h.Set("Access-Control-Allow-Origin", "*")

		if r.Method == http.MethodOptions {
			h.Set("Access-Control-Allow-Methods", "*")
			h.Set("Access-Control-Allow-Headers", "*")
			w.WriteHeader(http.StatusOK)
			return
		}
		next.ServeHTTP(w, r)
	})
}

// statusRecorder captures the status a handler wrote, for the access log.
type statusRecorder struct {
	http.ResponseWriter
	status int
}

func (s *statusRecorder) WriteHeader(code int) {
	if s.status == 0 {
		s.status = code
	}
	s.ResponseWriter.WriteHeader(code)
}

func (s *statusRecorder) Write(b []byte) (int, error) {
	if s.status == 0 {
		s.status = http.StatusOK
	}
	return s.ResponseWriter.Write(b)
}

func (s *statusRecorder) Unwrap() http.ResponseWriter { return s.ResponseWriter }

// Log records each request at debug level (tower-http's TraceLayer default) and
// recovers a panicking handler into a 500 rather than a dropped connection.
func Log(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		start := time.Now()
		rec := &statusRecorder{ResponseWriter: w}

		defer func() {
			if p := recover(); p != nil {
				if p == http.ErrAbortHandler {
					panic(p)
				}
				slog.ErrorContext(r.Context(), "handler panicked", "method", r.Method, "path", r.URL.Path, "panic", p)
				if rec.status == 0 {
					WriteJSON(rec, http.StatusInternalServerError, map[string]string{"error": "Internal server error"})
				}
			}
			slog.DebugContext(r.Context(), "request",
				"method", r.Method, "path", r.URL.Path, "status", rec.status, "duration", time.Since(start))
		}()

		next.ServeHTTP(rec, r)
	})
}

// Bare answers unrouted requests (404, and 405 with its Allow header) with an empty
// body, as axum did, instead of ServeMux's "404 page not found" text.
func Bare(mux *http.ServeMux) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if _, pattern := mux.Handler(r); pattern == "" {
			mux.ServeHTTP(bodyless{w}, r)
			return
		}
		mux.ServeHTTP(w, r)
	})
}

// bodyless drops the body ServeMux writes for its own errors.
type bodyless struct{ http.ResponseWriter }

func (b bodyless) WriteHeader(code int) {
	h := b.Header()
	h.Del("Content-Type")
	h.Del("X-Content-Type-Options")
	h.Set("Content-Length", "0")
	b.ResponseWriter.WriteHeader(code)
}

func (b bodyless) Write(p []byte) (int, error) { return len(p), nil }
