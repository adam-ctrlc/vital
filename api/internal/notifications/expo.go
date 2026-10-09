package notifications

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"time"
)

// Expo push service limits and defaults.
const (
	// ExpoPushURL is Expo's push endpoint.
	// https://docs.expo.dev/push-notifications/sending-notifications/
	ExpoPushURL = "https://exp.host/--/api/v2/push/send"
	// BatchSize is the most messages Expo accepts in one request.
	BatchSize = 100
	// DefaultTimeout bounds one batch request, connection to last byte. The Rust
	// API had no timeout; one is set here so a hung Expo cannot hold the ingest
	// request that raised the alert open indefinitely.
	DefaultTimeout = 10 * time.Second
)

// ExpoMessage is one message in an Expo push batch. Field order and names match
// what the Rust API sent.
type ExpoMessage struct {
	To    string `json:"to"`
	Title string `json:"title"`
	Body  string `json:"body"`
	// Priority "high" wakes the device promptly; alerts are the reason this app exists.
	Priority string `json:"priority"`
	Sound    string `json:"sound"`
	// ChannelID is the Android channel to deliver on, which is where the tone comes
	// from. Omitted rather than sent empty when the device has not said, so Android
	// falls back to the app's default channel.
	ChannelID *string `json:"channelId,omitempty"`
	// Data lets the app open straight to the alert it is about.
	Data MessageData `json:"data"`
}

// MessageData is the payload the app reads when a notification is opened.
type MessageData struct {
	AlertID int64  `json:"alertId"`
	Kind    string `json:"kind"`
}

// Sender delivers one batch of at most BatchSize messages.
type Sender interface {
	Send(ctx context.Context, batch []ExpoMessage) error
}

// StatusError is Expo answering a batch with a non-2xx status.
type StatusError struct {
	StatusCode int
	// Body is the start of the response body, for the log.
	Body string
}

func (e *StatusError) Error() string {
	return fmt.Sprintf("expo push: status %d: %s", e.StatusCode, e.Body)
}

// ExpoSender posts batches to Expo's push endpoint.
type ExpoSender struct {
	client   *http.Client
	endpoint string
	timeout  time.Duration
}

// NewExpoSender builds a sender. A nil client uses a new http.Client; an empty
// endpoint uses ExpoPushURL (tests point it at an httptest server). Each batch is
// bounded by DefaultTimeout whatever the client's own timeout.
func NewExpoSender(client *http.Client, endpoint string) *ExpoSender {
	if client == nil {
		client = &http.Client{Timeout: DefaultTimeout}
	}
	if endpoint == "" {
		endpoint = ExpoPushURL
	}
	return &ExpoSender{client: client, endpoint: endpoint, timeout: DefaultTimeout}
}

// maxErrorBody caps how much of a rejection is kept for the log.
const maxErrorBody = 512

// Send posts batch as a JSON array. Any 2xx is success; Expo's per-message tickets
// in the body are not inspected, as the Rust API did not.
func (s *ExpoSender) Send(ctx context.Context, batch []ExpoMessage) error {
	body, err := encodeBatch(batch)
	if err != nil {
		return err
	}

	ctx, cancel := context.WithTimeout(ctx, s.timeout)
	defer cancel()

	req, err := http.NewRequestWithContext(ctx, http.MethodPost, s.endpoint, bytes.NewReader(body))
	if err != nil {
		return fmt.Errorf("expo push: build request: %w", err)
	}
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("Accept", "application/json")

	resp, err := s.client.Do(req)
	if err != nil {
		return fmt.Errorf("expo push: %w", err)
	}
	defer resp.Body.Close()

	if resp.StatusCode < 200 || resp.StatusCode > 299 {
		snippet, _ := io.ReadAll(io.LimitReader(resp.Body, maxErrorBody))
		return &StatusError{StatusCode: resp.StatusCode, Body: string(snippet)}
	}

	// Drained so the connection can be reused.
	_, _ = io.Copy(io.Discard, resp.Body)
	return nil
}

// encodeBatch marshals like serde_json: no HTML escaping of <, > and &, and no
// trailing newline.
func encodeBatch(batch []ExpoMessage) ([]byte, error) {
	var buf bytes.Buffer
	enc := json.NewEncoder(&buf)
	enc.SetEscapeHTML(false)
	if err := enc.Encode(batch); err != nil {
		return nil, fmt.Errorf("expo push: encode batch: %w", err)
	}
	return bytes.TrimSuffix(buf.Bytes(), []byte("\n")), nil
}
