package notifications

import (
	"context"
	"errors"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"testing"
	"time"
)

// captured is one request the fake Expo received.
type captured struct {
	method, path, contentType, accept string
	body                              string
}

// fakeExpo records every request and answers with status. Read the record only
// after the sends under test have returned.
func fakeExpo(t *testing.T, status int) (*httptest.Server, *[]captured) {
	t.Helper()
	var (
		mu  sync.Mutex
		got []captured
	)
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		body, _ := io.ReadAll(r.Body)
		mu.Lock()
		defer mu.Unlock()
		got = append(got, captured{
			method: r.Method, path: r.URL.Path,
			contentType: r.Header.Get("Content-Type"), accept: r.Header.Get("Accept"),
			body: string(body),
		})
		w.WriteHeader(status)
		_, _ = io.WriteString(w, `{"data":[{"status":"ok","id":"x"}]}`)
	}))
	t.Cleanup(srv.Close)
	return srv, &got
}

func TestExpoSenderPayload(t *testing.T) {
	srv, got := fakeExpo(t, http.StatusOK)
	s := NewExpoSender(srv.Client(), srv.URL+"/--/api/v2/push/send")

	batch := []ExpoMessage{
		{
			To: "ExponentPushToken[a]", Title: "Transformer overloaded", Body: "Load reached 950 VA",
			Priority: "high", Sound: "default", ChannelID: ptr("alarm-siren"),
			Data: MessageData{AlertID: 12, Kind: "overload"},
		},
		{
			To: "ExponentPushToken[b]", Title: "Transformer overheating", Body: "Temperature reached 41.0 °C <&>",
			Priority: "high", Sound: "default",
			Data: MessageData{AlertID: 13, Kind: "temperature"},
		},
	}
	if err := s.Send(context.Background(), batch); err != nil {
		t.Fatal(err)
	}

	if len(*got) != 1 {
		t.Fatalf("got %d requests, want 1", len(*got))
	}
	req := (*got)[0]
	if req.method != http.MethodPost || req.path != "/--/api/v2/push/send" {
		t.Errorf("request = %s %s", req.method, req.path)
	}
	if req.contentType != "application/json" || req.accept != "application/json" {
		t.Errorf("headers: content-type %q, accept %q", req.contentType, req.accept)
	}

	// Exactly what serde_json wrote for the same Vec<ExpoMessage>: a JSON array, no
	// HTML escaping, channelId omitted when absent, no trailing newline.
	want := `[{"to":"ExponentPushToken[a]","title":"Transformer overloaded","body":"Load reached 950 VA",` +
		`"priority":"high","sound":"default","channelId":"alarm-siren","data":{"alertId":12,"kind":"overload"}},` +
		`{"to":"ExponentPushToken[b]","title":"Transformer overheating","body":"Temperature reached 41.0 °C <&>",` +
		`"priority":"high","sound":"default","data":{"alertId":13,"kind":"temperature"}}]`
	if req.body != want {
		t.Errorf("body\n got %s\nwant %s", req.body, want)
	}
}

func TestExpoSenderDefaults(t *testing.T) {
	s := NewExpoSender(nil, "")
	if s.endpoint != "https://exp.host/--/api/v2/push/send" {
		t.Errorf("endpoint = %q", s.endpoint)
	}
	if s.client == nil || s.client.Timeout != DefaultTimeout || s.timeout != DefaultTimeout {
		t.Errorf("client timeout %v, batch timeout %v", s.client.Timeout, s.timeout)
	}
}

func TestExpoSenderStatus(t *testing.T) {
	tests := []struct {
		status  int
		wantErr bool
	}{
		{http.StatusOK, false},
		{http.StatusAccepted, false},
		{http.StatusBadRequest, true},
		{http.StatusTooManyRequests, true},
		{http.StatusInternalServerError, true},
	}
	for _, tt := range tests {
		t.Run(http.StatusText(tt.status), func(t *testing.T) {
			srv, _ := fakeExpo(t, tt.status)
			err := NewExpoSender(srv.Client(), srv.URL).Send(context.Background(), []ExpoMessage{{To: "t"}})

			var se *StatusError
			if tt.wantErr {
				if !errors.As(err, &se) || se.StatusCode != tt.status {
					t.Fatalf("err = %v, want StatusError %d", err, tt.status)
				}
				if !strings.Contains(se.Body, `"status":"ok"`) {
					t.Errorf("body snippet = %q", se.Body)
				}
			} else if err != nil {
				t.Fatal(err)
			}
		})
	}
}

func TestExpoSenderTimesOut(t *testing.T) {
	release := make(chan struct{})
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		select {
		case <-release:
		case <-r.Context().Done():
		}
	}))
	t.Cleanup(func() { close(release); srv.Close() })

	s := NewExpoSender(srv.Client(), srv.URL)
	s.timeout = 50 * time.Millisecond

	start := time.Now()
	err := s.Send(context.Background(), []ExpoMessage{{To: "t"}})
	if !errors.Is(err, context.DeadlineExceeded) {
		t.Fatalf("err = %v, want deadline exceeded", err)
	}
	if elapsed := time.Since(start); elapsed > 2*time.Second {
		t.Errorf("took %v", elapsed)
	}
}

func TestExpoSenderHonoursCancellation(t *testing.T) {
	srv, got := fakeExpo(t, http.StatusOK)
	ctx, cancel := context.WithCancel(context.Background())
	cancel()

	err := NewExpoSender(srv.Client(), srv.URL).Send(ctx, []ExpoMessage{{To: "t"}})
	if !errors.Is(err, context.Canceled) {
		t.Fatalf("err = %v, want canceled", err)
	}
	if len(*got) != 0 {
		t.Errorf("sent %d requests after cancellation", len(*got))
	}
}

func TestExpoSenderUnreachable(t *testing.T) {
	srv := httptest.NewServer(http.NotFoundHandler())
	url := srv.URL
	srv.Close()

	err := NewExpoSender(nil, url).Send(context.Background(), []ExpoMessage{{To: "t"}})
	var se *StatusError
	if err == nil || errors.As(err, &se) {
		t.Fatalf("err = %v, want a transport error", err)
	}
}
