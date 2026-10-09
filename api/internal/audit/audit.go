// Package audit is the record of who changed what: thresholds, the relay, accounts.
// Handlers write to it through Log.Record after a change succeeds; admins read it at
// GET /api/v1/audit.
package audit

import (
	"context"
	"database/sql"
	"encoding/json"
	"fmt"
	"log/slog"
	"reflect"

	"github.com/google/uuid"
)

// Actions recorded.
const (
	SettingsUpdate  = "settings.update"
	SettingsSource  = "settings.source"
	RelayOpen       = "relay.open"
	RelayClose      = "relay.close"
	UserCreate      = "user.create"
	UserUpdate      = "user.update"
	UserDelete      = "user.delete"
	UserApprove     = "user.approve"
	AccountUpdate   = "account.update"
	AccountPassword = "account.password"
)

// Change is one field's before and after.
type Change struct {
	From any `json:"from"`
	To   any `json:"to"`
}

// Changes is a detail of the form {"field": {"from": old, "to": new}}.
type Changes map[string]Change

// Add records field when from and to differ. Nil pointers read as null and set ones as
// their value, so a *string that moved from nil to "x" is a change and two equal
// values are not.
func (c Changes) Add(field string, from, to any) {
	from, to = deref(from), deref(to)
	if reflect.DeepEqual(from, to) {
		return
	}
	c[field] = Change{From: from, To: to}
}

func deref(v any) any {
	rv := reflect.ValueOf(v)
	if rv.Kind() != reflect.Pointer {
		return v
	}
	if rv.IsNil() {
		return nil
	}
	return rv.Elem().Interface()
}

// insertSQL stores an event. actor_name is the actor's full name as it reads now,
// composed the way users.FullName composes it from the stored (already trimmed) parts.
const insertSQL = `insert into audit_events (actor_id, actor_name, action, target, detail)
values (?1,
        (select first_name || ' ' || coalesce(middle_name || ' ', '') || last_name from users where id = ?1),
        ?2, ?3, ?4)`

// Log writes audit events.
type Log struct {
	db *sql.DB
}

// NewLog returns a log over conn.
func NewLog(conn *sql.DB) *Log { return &Log{db: conn} }

// Record writes one event for a change that has already happened.
//
// Best effort, after the change rather than in its transaction: the change is what the
// operator asked for, and failing it because its record could not be written would be
// worse than a gap in the record. Over libSQL's HTTP protocol a transaction is also
// several more round trips on every edit. A failure is logged. A nil Log records nothing.
func (l *Log) Record(ctx context.Context, actor uuid.UUID, action, target string, detail any) {
	if l == nil {
		return
	}
	// Detached, so a caller hanging up after the change does not drop its record.
	ctx = context.WithoutCancel(ctx)

	var detailJSON any
	if detail != nil && !(isEmptyChanges(detail)) {
		b, err := json.Marshal(detail)
		if err != nil {
			slog.ErrorContext(ctx, "audit: encode detail", "action", action, "error", err)
			return
		}
		detailJSON = string(b)
	}
	var targetArg any
	if target != "" {
		targetArg = target
	}
	if _, err := l.db.ExecContext(ctx, insertSQL, actor.String(), action, targetArg, detailJSON); err != nil {
		slog.ErrorContext(ctx, "audit: record failed", "action", action, "error", fmt.Errorf("insert: %w", err))
	}
}

func isEmptyChanges(v any) bool {
	c, ok := v.(Changes)
	return ok && len(c) == 0
}
