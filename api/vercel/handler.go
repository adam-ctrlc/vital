// Package vercel serves the API from the Vercel Go runtime. api/index.go is only a
// wrapper around Handler, because the runtime builds that file under a module it
// renames to "handler", and Go refuses an internal import from outside this module's
// path. This package is inside it, so it may import internal/... on the entrypoint's
// behalf.
package vercel

import (
	"log/slog"
	"net/http"
	"os"
	"sync"

	"github.com/adam-ctrlc/vital/api/internal/app"
	"github.com/adam-ctrlc/vital/api/internal/config"
	"github.com/adam-ctrlc/vital/api/internal/httpx"
)

var (
	mu    sync.Mutex
	built http.Handler
)

func init() {
	slog.SetDefault(slog.New(slog.NewJSONHandler(os.Stderr, nil)))
}

// load builds the app once per instance. A failure is not cached: the next request
// tries again, so a transient fault does not pin a warm instance to 500s.
func load() (http.Handler, error) {
	mu.Lock()
	defer mu.Unlock()
	if built != nil {
		return built, nil
	}

	cfg, err := config.Load()
	if err != nil {
		return nil, &httpx.Error{Status: http.StatusInternalServerError, Message: err.Error(), Cause: err}
	}
	h, err := app.New(cfg)
	if err != nil {
		return nil, err
	}
	built = h
	return built, nil
}

// Handler serves every /api/v1 request. vercel.json rewrites /api/v1/:path* to the
// function and the request keeps its original path, so the router sees /api/v1/...
// exactly as the local server does.
func Handler(w http.ResponseWriter, r *http.Request) {
	h, err := load()
	if err != nil {
		slog.Error("failed to build app", "error", err)
		httpx.WriteError(w, r, err)
		return
	}
	h.ServeHTTP(w, r)
}
