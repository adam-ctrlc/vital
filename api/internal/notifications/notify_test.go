package notifications

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"log/slog"
	"net/http"
	"reflect"
	"strings"
	"testing"

	"github.com/adam-ctrlc/vital/api/internal/alerts"
)

type fakeDevices struct {
	devices []Device
	err     error
	calls   int
}

func (f *fakeDevices) Devices(ctx context.Context) ([]Device, error) {
	f.calls++
	if ctx.Err() != nil {
		return nil, ctx.Err()
	}
	return f.devices, f.err
}

// recordingSender records batch sizes and fails the batches listed in fail.
type recordingSender struct {
	sizes []int
	fail  map[int]error
}

func (r *recordingSender) Send(ctx context.Context, batch []ExpoMessage) error {
	r.sizes = append(r.sizes, len(batch))
	if ctx.Err() != nil {
		return ctx.Err()
	}
	return r.fail[len(r.sizes)-1]
}

func devices(n int) []Device {
	out := make([]Device, n)
	for i := range out {
		out[i] = Device{Token: fmt.Sprintf("ExponentPushToken[%d]", i)}
	}
	return out
}

func overloadAlert() alerts.Alert {
	return alerts.Alert{ID: 12, Kind: alerts.KindOverload, Message: "Load reached 950 VA"}
}

func TestMessages(t *testing.T) {
	a := alerts.Alert{ID: 3, Kind: alerts.KindTemperature, Message: "Temperature reached 41.0 °C"}
	got := Messages(a, []Device{{Token: "a", ChannelID: ptr("siren")}, {Token: "b"}})
	want := []ExpoMessage{
		{To: "a", Title: "Transformer overheating", Body: "Temperature reached 41.0 °C", Priority: "high",
			Sound: "default", ChannelID: ptr("siren"), Data: MessageData{AlertID: 3, Kind: "temperature"}},
		{To: "b", Title: "Transformer overheating", Body: "Temperature reached 41.0 °C", Priority: "high",
			Sound: "default", Data: MessageData{AlertID: 3, Kind: "temperature"}},
	}
	if !reflect.DeepEqual(got, want) {
		t.Errorf("got %+v\nwant %+v", got, want)
	}
}

func TestTitle(t *testing.T) {
	tests := []struct {
		kind alerts.Kind
		want string
	}{
		{alerts.KindOverload, "Transformer overloaded"},
		{alerts.KindTemperature, "Transformer overheating"},
		{"anything else", "Transformer overloaded"},
	}
	for _, tt := range tests {
		if got := Title(tt.kind); got != tt.want {
			t.Errorf("Title(%q) = %q, want %q", tt.kind, got, tt.want)
		}
	}
}

func TestNotifyAlertBatching(t *testing.T) {
	tests := []struct {
		name    string
		devices int
		want    []int
	}{
		{"no devices sends nothing", 0, nil},
		{"one device", 1, []int{1}},
		{"exactly one batch", 100, []int{100}},
		{"one over a batch", 101, []int{100, 1}},
		{"several batches", 250, []int{100, 100, 50}},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			sender := &recordingSender{}
			NewService(&fakeDevices{devices: devices(tt.devices)}, sender, nil).
				NotifyAlert(context.Background(), overloadAlert())
			if !reflect.DeepEqual(sender.sizes, tt.want) {
				t.Errorf("batches %v, want %v", sender.sizes, tt.want)
			}
		})
	}
}

func TestNotifyAlertFailuresAreLoggedNotFatal(t *testing.T) {
	t.Run("token load failure sends nothing", func(t *testing.T) {
		var logs bytes.Buffer
		sender := &recordingSender{}
		NewService(&fakeDevices{err: errors.New("db down")}, sender, slog.New(slog.NewTextHandler(&logs, nil))).
			NotifyAlert(context.Background(), overloadAlert())
		if len(sender.sizes) != 0 {
			t.Errorf("sent %v", sender.sizes)
		}
		if !strings.Contains(logs.String(), "could not load push tokens") {
			t.Errorf("logs: %s", logs.String())
		}
	})

	t.Run("a failed batch does not stop the next", func(t *testing.T) {
		var logs bytes.Buffer
		sender := &recordingSender{fail: map[int]error{
			0: &StatusError{StatusCode: 500},
			1: errors.New("connection refused"),
		}}
		NewService(&fakeDevices{devices: devices(250)}, sender, slog.New(slog.NewTextHandler(&logs, nil))).
			NotifyAlert(context.Background(), overloadAlert())
		if !reflect.DeepEqual(sender.sizes, []int{100, 100, 50}) {
			t.Errorf("batches %v", sender.sizes)
		}
		for _, line := range []string{"expo rejected the push", "could not reach expo push", "alert pushed"} {
			if !strings.Contains(logs.String(), line) {
				t.Errorf("missing log %q in %s", line, logs.String())
			}
		}
	})
}

// The alert is already stored when this runs, so a caller hanging up must not cut the
// announcement off.
func TestNotifyAlertOutlivesCallerCancellation(t *testing.T) {
	ctx, cancel := context.WithCancel(context.Background())
	cancel()

	list := &fakeDevices{devices: devices(1)}
	sender := &recordingSender{}
	var logs bytes.Buffer
	NewService(list, sender, slog.New(slog.NewTextHandler(&logs, nil))).NotifyAlert(ctx, overloadAlert())

	if !reflect.DeepEqual(sender.sizes, []int{1}) || !strings.Contains(logs.String(), "alert pushed") {
		t.Errorf("batches %v, logs %s", sender.sizes, logs.String())
	}
}

// End to end through the real sender: every device gets its own message, split into
// Expo-sized requests.
func TestNotifyAlertThroughExpoSender(t *testing.T) {
	srv, got := fakeExpo(t, http.StatusOK)
	list := devices(150)
	list[0].ChannelID = ptr("alarm-siren")

	NewService(&fakeDevices{devices: list}, NewExpoSender(srv.Client(), srv.URL), nil).
		NotifyAlert(context.Background(), overloadAlert())

	if len(*got) != 2 {
		t.Fatalf("got %d requests, want 2", len(*got))
	}
	var sizes []int
	var first []map[string]any
	for i, req := range *got {
		var batch []map[string]any
		if err := json.Unmarshal([]byte(req.body), &batch); err != nil {
			t.Fatal(err)
		}
		sizes = append(sizes, len(batch))
		if i == 0 {
			first = batch
		}
	}
	if !reflect.DeepEqual(sizes, []int{100, 50}) {
		t.Errorf("batch sizes %v", sizes)
	}
	if first[0]["channelId"] != "alarm-siren" {
		t.Errorf("first message channelId = %v", first[0]["channelId"])
	}
	if _, ok := first[1]["channelId"]; ok {
		t.Errorf("channelId sent for a device without one: %v", first[1])
	}
	wantData := map[string]any{"alertId": float64(12), "kind": "overload"}
	if !reflect.DeepEqual(first[1]["data"], wantData) || first[1]["title"] != "Transformer overloaded" ||
		first[1]["body"] != "Load reached 950 VA" || first[1]["priority"] != "high" || first[1]["sound"] != "default" {
		t.Errorf("message = %v", first[1])
	}
}
