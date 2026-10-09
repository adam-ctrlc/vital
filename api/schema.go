// Package api embeds the database schema so cmd/migrate carries it in the binary.
package api

import _ "embed"

// Schema is schema.sql: the whole schema, every statement "if not exists".
//
//go:embed schema.sql
var Schema string
