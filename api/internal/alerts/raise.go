package alerts

import (
	"context"
	"fmt"
	"log/slog"
)

// RenotifyAfterSeconds is how long an ongoing condition waits before announcing
// itself again.
//
// An alarm that speaks once and then goes quiet while the fault continues is not an
// alarm. This is deliberately far longer than the reading interval: the point is to
// keep saying it, not to say it every few seconds.
const RenotifyAfterSeconds int64 = 60

// RaiseStore is the persistence alert evaluation needs, one statement per method.
// *Store implements it over the database; tests use a fake.
type RaiseStore interface {
	// ClaimRenotify runs SQLClaimRenotify: it marks the open alert of kind as
	// announced now if it was last announced at least afterSeconds ago, and returns
	// it. ok is false when there is no open alert or it is not due yet.
	ClaimRenotify(ctx context.Context, kind Kind, afterSeconds int64) (a Alert, ok bool, err error)

	// ActiveID runs SQLActiveAlertID. ok is false when no alert of kind is open.
	ActiveID(ctx context.Context, kind Kind) (id int64, ok bool, err error)

	// Open runs SQLOpenAlert. opened is false, with a nil error, when the partial
	// unique index alerts_one_active_per_kind refused the insert because a
	// concurrent request opened the same kind first (db.IsUniqueViolation), or when
	// the insert returned no row. Any other failure is an error.
	Open(ctx context.Context, readingID int64, c Condition) (a Alert, opened bool, err error)
}

// Notifier announces an alert to every registered device.
//
// It reports nothing back: a push that does not send must not fail the request that
// raised the alert. Recording the alert matters more than announcing it.
type Notifier interface {
	NotifyAlert(ctx context.Context, a Alert)
}

// Service opens and re-announces alerts for incoming readings.
type Service struct {
	store    RaiseStore
	notifier Notifier
	log      *slog.Logger
}

// NewService builds a Service. A nil logger discards.
func NewService(store RaiseStore, notifier Notifier, log *slog.Logger) *Service {
	if log == nil {
		log = slog.New(slog.DiscardHandler)
	}
	return &Service{store: store, notifier: notifier, log: log}
}

// Evaluate opens or re-announces an alert for every threshold m crosses.
//
// A store failure is returned and stops evaluation (an overload failure means the
// temperature is not evaluated), as the Rust API's ? did; the reading itself is
// already stored by then. Push failures are never returned.
//
// The push is awaited, not spawned: a serverless function may be frozen the moment
// it responds, cutting a detached goroutine off mid-flight.
func (s *Service) Evaluate(ctx context.Context, m Measurement, t Thresholds) error {
	for _, c := range Conditions(m, t) {
		if err := s.raise(ctx, m.ReadingID, c); err != nil {
			return fmt.Errorf("raise %s alert: %w", c.Kind, err)
		}
	}
	return nil
}

// raise opens an alert only when nothing of the same kind is still unacknowledged,
// so a fast heartbeat cannot flood the list with duplicates of one ongoing condition.
//
// The list is de-duplicated; the notification is not. An open condition is announced
// again every RenotifyAfterSeconds against the same alert (with its original message,
// value and threshold), so the history stays one row per condition while the phone
// keeps being told.
func (s *Service) raise(ctx context.Context, readingID int64, c Condition) error {
	claimed, ok, err := s.store.ClaimRenotify(ctx, c.Kind, RenotifyAfterSeconds)
	if err != nil {
		return fmt.Errorf("claim renotify: %w", err)
	}
	if ok {
		s.log.InfoContext(ctx, "condition ongoing, announcing again",
			"kind", c.Kind, "value", c.Value, "alert_id", claimed.ID)
		s.notifier.NotifyAlert(ctx, claimed)
		return nil
	}

	// Nothing claimed: either no open alert of this kind, or one announced too
	// recently to say again.
	open, ok, err := s.store.ActiveID(ctx, c.Kind)
	if err != nil {
		return fmt.Errorf("find active alert: %w", err)
	}
	if ok {
		s.log.DebugContext(ctx, "condition ongoing, announced too recently",
			"kind", c.Kind, "value", c.Value, "open", open)
		return nil
	}

	opened, ok, err := s.store.Open(ctx, readingID, c)
	if err != nil {
		return fmt.Errorf("open alert: %w", err)
	}
	if !ok {
		// Lost the race to a concurrent request: the condition is already raised and
		// already announced, so there is nothing to report.
		return nil
	}

	s.log.InfoContext(ctx, "alert raised",
		"kind", c.Kind, "value", c.Value, "threshold", c.Threshold)
	s.notifier.NotifyAlert(ctx, opened)

	return nil
}
