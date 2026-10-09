// Command migrate applies the schema to DATABASE_URL.
//
// Separate from the server on purpose: applying it at startup would replay the schema
// on every serverless cold start, and a schema change is something a person decides
// to make. Safe to repeat, since every statement in schema.sql is "if not exists".
//
//	go run ./cmd/migrate                                    # embedded schema.sql
//	go run ./cmd/migrate -file migrations/0023_account_approval.sql   # one migration (not idempotent)
//	go run -tags sqlite ./cmd/migrate                       # DATABASE_URL may be file:...
package main

import (
	"context"
	"flag"
	"fmt"
	"log/slog"
	"os"
	"strings"

	api "github.com/adam-ctrlc/vital/api"
	"github.com/adam-ctrlc/vital/api/internal/config"
	"github.com/adam-ctrlc/vital/api/internal/db"
)

func main() {
	file := flag.String("file", "", "apply this SQL file instead of the embedded schema.sql")
	flag.Parse()

	if err := run(context.Background(), *file); err != nil {
		slog.Error("migrate failed", "error", err)
		os.Exit(1)
	}
}

func run(ctx context.Context, file string) error {
	if _, err := config.LoadDotenv(".env"); err != nil {
		return err
	}
	cfg, err := config.Load()
	if err != nil {
		return err
	}

	schema := api.Schema
	if file != "" {
		b, err := os.ReadFile(file)
		if err != nil {
			return err
		}
		schema = string(b)
	}

	conn, err := db.Open(cfg.DatabaseURL, cfg.DatabaseToken)
	if err != nil {
		return err
	}
	defer conn.Close()

	applied, err := db.ApplySchema(ctx, conn, schema)
	if err != nil {
		return err
	}
	fmt.Printf("applied %d statements\n", applied)

	// Read back rather than trusting the count: an earlier splitter reported every
	// statement applied while silently dropping two.
	rows, err := conn.QueryContext(ctx, `select name from sqlite_master
		where type in ('table', 'index') and name not like 'sqlite_%'
		order by type, name`)
	if err != nil {
		return fmt.Errorf("list schema: %w", err)
	}
	defer rows.Close()

	var names []string
	for rows.Next() {
		var name string
		if err := rows.Scan(&name); err != nil {
			return err
		}
		names = append(names, name)
	}
	if err := rows.Err(); err != nil {
		return err
	}
	fmt.Printf("database now holds: %s\n", strings.Join(names, ", "))
	return nil
}
