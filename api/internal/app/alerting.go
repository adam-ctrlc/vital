package app

import (
	"context"
	"database/sql"
	"errors"
	"log/slog"
	"testing"

	"github.com/adam-ctrlc/vital/api/internal/alerts"
	"github.com/adam-ctrlc/vital/api/internal/notifications"
)

// newAlerts wires alert evaluation: alerts are stored through alerts.Store and
// announced to every registered device by notifications.Service through push.
func newAlerts(conn *sql.DB, push notifications.Sender) *alerts.Service {
	notifier := notifications.NewService(notifications.NewStore(conn), push, slog.Default())
	return alerts.NewService(alerts.NewStore(conn), notifier, slog.Default())
}

// defaultPush is Expo's push service, except under go test, where it refuses every
// batch: no test may reach exp.host, whatever tokens its database holds. Tests that
// exercise delivery pass their own sender through WithPush.
func defaultPush() notifications.Sender {
	if testing.Testing() {
		return refusePush{}
	}
	return notifications.NewExpoSender(nil, "")
}

// WithPush returns d with alerts announced through push instead of Expo, for tests
// (an ExpoSender pointed at an httptest server, or a fake). Call it before Routes.
func (d Deps) WithPush(push notifications.Sender) Deps {
	d.Alerts = newAlerts(d.DB, push)
	return d
}

// errPushDisabled is what refusePush answers; NotifyAlert logs it and moves on.
var errPushDisabled = errors.New("push disabled under go test")

type refusePush struct{}

func (refusePush) Send(context.Context, []notifications.ExpoMessage) error { return errPushDisabled }
