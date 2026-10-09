package notifications

import (
	"context"
	"errors"
	"log/slog"

	"github.com/adam-ctrlc/vital/api/internal/alerts"
)

// Device is a registered push token and the channel it asked for (nil if none).
type Device struct {
	Token     string
	ChannelID *string
}

// DeviceLister loads every registered device. *Store implements it.
type DeviceLister interface {
	Devices(ctx context.Context) ([]Device, error)
}

// Service announces alerts to every registered device. It implements
// alerts.Notifier.
type Service struct {
	devices DeviceLister
	sender  Sender
	log     *slog.Logger
}

var _ alerts.Notifier = (*Service)(nil)

// NewService builds a Service. A nil logger discards.
func NewService(devices DeviceLister, sender Sender, log *slog.Logger) *Service {
	if log == nil {
		log = slog.New(slog.DiscardHandler)
	}
	return &Service{devices: devices, sender: sender, log: log}
}

// NotifyAlert pushes a to every registered device, in batches of BatchSize sent one
// after another.
//
// Failures are logged, never returned: a push that does not send must not fail the
// request that raised the alert. A failed batch does not stop the next one.
//
// The work is detached from ctx's cancellation (but keeps its values): the alert is
// already stored, and a board hanging up mid-request should not cut the
// announcement off. Each batch is still bounded by the sender's timeout.
func (s *Service) NotifyAlert(ctx context.Context, a alerts.Alert) {
	ctx = context.WithoutCancel(ctx)

	devices, err := s.devices.Devices(ctx)
	if err != nil {
		s.log.ErrorContext(ctx, "could not load push tokens", "error", err)
		return
	}
	if len(devices) == 0 {
		return
	}

	messages := Messages(a, devices)

	for start := 0; start < len(messages); start += BatchSize {
		batch := messages[start:min(start+BatchSize, len(messages))]

		err := s.sender.Send(ctx, batch)
		var status *StatusError
		switch {
		case err == nil:
			s.log.InfoContext(ctx, "alert pushed", "alert_id", a.ID, "devices", len(batch))
		case errors.As(err, &status):
			s.log.ErrorContext(ctx, "expo rejected the push",
				"status", status.StatusCode, "body", status.Body)
		default:
			s.log.ErrorContext(ctx, "could not reach expo push", "error", err)
		}
	}
}

// Title is the notification title for an alert kind. Anything that is not a
// temperature alert reads as an overload.
func Title(kind alerts.Kind) string {
	if kind == alerts.KindTemperature {
		return "Transformer overheating"
	}
	return "Transformer overloaded"
}

// Messages builds one high-priority message per device, each on that device's own
// channel, because the tone is a per-device choice.
func Messages(a alerts.Alert, devices []Device) []ExpoMessage {
	title := Title(a.Kind)
	out := make([]ExpoMessage, 0, len(devices))
	for _, d := range devices {
		out = append(out, ExpoMessage{
			To:        d.Token,
			Title:     title,
			Body:      a.Message,
			Priority:  "high",
			Sound:     "default",
			ChannelID: d.ChannelID,
			Data:      MessageData{AlertID: a.ID, Kind: string(a.Kind)},
		})
	}
	return out
}
