package device

import (
	"errors"
	"net/http"
	"net/http/httptest"
	"reflect"
	"strings"
	"testing"

	"github.com/adam-ctrlc/vital/api/internal/httpx"
)

// decode runs body through the foundation's JSON extractor, as the handlers will,
// and returns the status a failure would produce (0 on success).
func decode(t *testing.T, body string, dst any) int {
	t.Helper()
	r := httptest.NewRequest(http.MethodPost, "/", strings.NewReader(body))
	r.Header.Set("Content-Type", "application/json")
	err := httpx.DecodeJSON(r, dst)
	if err == nil {
		return 0
	}
	var apiErr *httpx.Error
	if !errors.As(err, &apiErr) {
		t.Fatalf("DecodeJSON returned %T, want *httpx.Error: %v", err, err)
	}
	return apiErr.Status
}

func ptr[T any](v T) *T { return &v }

// firmwareHeartbeat is what BackendClient::postHeartbeat serializes, including an
// SSID with the characters that once broke the hand-built JSON.
const firmwareHeartbeat = `{"deviceId":"vital-esp32-01","firmware":"1.0.0","ssid":"Cafe \"5G\" \\ guest",` +
	`"ipAddress":"192.168.1.20","signalDbm":-61,"uptimeSeconds":4294967,"relayLockedOut":true}`

func TestDecodeHeartbeat(t *testing.T) {
	tests := []struct {
		name       string
		body       string
		want       Heartbeat
		wantStatus int
	}{
		{
			name: "the flashed firmware's body",
			body: firmwareHeartbeat,
			want: Heartbeat{
				DeviceID:       ptr("vital-esp32-01"),
				Firmware:       ptr("1.0.0"),
				SSID:           ptr(`Cafe "5G" \ guest`),
				IPAddress:      ptr("192.168.1.20"),
				SignalDBm:      ptr[int32](-61),
				UptimeSeconds:  ptr[int64](4294967),
				RelayLockedOut: ptr(true),
			},
		},
		{
			name: "a partial heartbeat leaves the rest absent",
			body: `{"uptimeSeconds":12}`,
			want: Heartbeat{UptimeSeconds: ptr[int64](12)},
		},
		{
			name: "null reads as absent",
			body: `{"deviceId":null,"relayLockedOut":null,"signalDbm":null}`,
			want: Heartbeat{},
		},
		{
			name: "an empty object is a heartbeat with nothing to report",
			body: `{}`,
			want: Heartbeat{},
		},
		{
			name: "unknown fields are ignored so newer firmware still reports",
			body: `{"firmware":"2.0.0","freeHeap":81234}`,
			want: Heartbeat{Firmware: ptr("2.0.0")},
		},
		{
			name: "acknowledging firmware: the ack and the reset reason",
			body: `{"uptimeSeconds":5,"relayCommandAck":12,"resetReason":"brownout"}`,
			want: Heartbeat{UptimeSeconds: ptr[int64](5), RelayCommandAck: ptr[int64](12), ResetReason: ptr("brownout")},
		},
		{
			name: "an ack of zero is present, not absent",
			body: `{"relayCommandAck":0}`,
			want: Heartbeat{RelayCommandAck: ptr[int64](0)},
		},
		{
			name: "uptime past 32 bits still fits",
			body: `{"uptimeSeconds":4294967295}`,
			want: Heartbeat{UptimeSeconds: ptr[int64](4294967295)},
		},
		{name: "not JSON", body: `{"deviceId":`, wantStatus: http.StatusBadRequest},
		{name: "empty body", body: ``, wantStatus: http.StatusBadRequest},
		{name: "null body", body: `null`, wantStatus: http.StatusUnprocessableEntity},
		{name: "array body", body: `[]`, wantStatus: http.StatusUnprocessableEntity},
		{name: "signal as text", body: `{"signalDbm":"-61"}`, wantStatus: http.StatusUnprocessableEntity},
		{name: "fractional signal", body: `{"signalDbm":-61.5}`, wantStatus: http.StatusUnprocessableEntity},
		{name: "signal beyond i32", body: `{"signalDbm":2147483648}`, wantStatus: http.StatusUnprocessableEntity},
		{name: "lockout as integer", body: `{"relayLockedOut":1}`, wantStatus: http.StatusUnprocessableEntity},
		{name: "device id as number", body: `{"deviceId":7}`, wantStatus: http.StatusUnprocessableEntity},
		{name: "ack as text", body: `{"relayCommandAck":"3"}`, wantStatus: http.StatusUnprocessableEntity},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			var got Heartbeat
			status := decode(t, tt.body, &got)
			if status != tt.wantStatus {
				t.Fatalf("status = %d, want %d", status, tt.wantStatus)
			}
			if tt.wantStatus == 0 && !reflect.DeepEqual(got, tt.want) {
				t.Errorf("decoded %+v, want %+v", got, tt.want)
			}
		})
	}
}

func TestHeartbeatArgs(t *testing.T) {
	tests := []struct {
		name string
		hb   Heartbeat
		want []any
	}{
		{
			name: "absent fields are SQL NULL so coalesce keeps the stored value",
			hb:   Heartbeat{},
			want: []any{nil, nil, nil, nil, nil, nil, nil, nil},
		},
		{
			name: "values are dereferenced in placeholder order",
			hb: Heartbeat{
				DeviceID:       ptr("id"),
				Firmware:       ptr("fw"),
				SSID:           ptr("ssid"),
				IPAddress:      ptr("10.0.0.2"),
				SignalDBm:      ptr[int32](-70),
				UptimeSeconds:  ptr[int64](99),
				RelayLockedOut: ptr(false),
				ResetReason:    ptr("Panic"),
				// Not a column: the handover reads it, so args leaves it out.
				RelayCommandAck: ptr[int64](4),
			},
			want: []any{"id", "fw", "ssid", "10.0.0.2", int32(-70), int64(99), false, "panic"},
		},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			if got := tt.hb.args(); !reflect.DeepEqual(got, tt.want) {
				t.Errorf("args() = %#v, want %#v", got, tt.want)
			}
		})
	}
}
