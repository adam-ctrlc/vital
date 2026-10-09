// Command server runs the API locally on PORT (default 8080).
//
//	go run ./cmd/server                 # reads .env
//	go run -tags sqlite ./cmd/server    # also accepts DATABASE_URL=file:/path/dev.db
package main

import (
	"context"
	"errors"
	"fmt"
	"log/slog"
	"net/http"
	"os"
	"os/signal"
	"syscall"
	"time"

	"github.com/adam-ctrlc/vital/api/internal/app"
	"github.com/adam-ctrlc/vital/api/internal/config"
)

func main() {
	slog.SetDefault(slog.New(slog.NewTextHandler(os.Stderr, nil)))
	if err := run(); err != nil {
		slog.Error("server stopped", "error", err)
		os.Exit(1)
	}
}

func run() error {
	if path, err := config.LoadDotenv(".env"); err != nil {
		return err
	} else if path != "" {
		slog.Info("loaded environment file", "path", path)
	}

	cfg, err := config.Load()
	if err != nil {
		return err
	}
	handler, err := app.New(cfg)
	if err != nil {
		return err
	}

	srv := &http.Server{
		Addr:              fmt.Sprintf("0.0.0.0:%d", cfg.Port),
		Handler:           handler,
		ReadHeaderTimeout: 10 * time.Second,
	}

	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stop()

	errc := make(chan error, 1)
	go func() {
		slog.Info("dynavolt api listening", "address", srv.Addr)
		errc <- srv.ListenAndServe()
	}()

	select {
	case err := <-errc:
		return err
	case <-ctx.Done():
	}

	shutdown, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	if err := srv.Shutdown(shutdown); err != nil && !errors.Is(err, http.ErrServerClosed) {
		return err
	}
	return nil
}
