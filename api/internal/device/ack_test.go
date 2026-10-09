package device

import (
	"encoding/json"
	"maps"
	"slices"
	"testing"

	"github.com/adam-ctrlc/vital/api/internal/settings"
)

// defaultThresholds is the schema's seeded settings row.
var defaultThresholds = settings.Settings{
	LoadThresholdVA:     900,
	TripThresholdVA:     980,
	TempThresholdC:      40,
	RecloseDelaySeconds: 30,
	TripConfirmSeconds:  3,
	SourceMode:          "hardware",
}

func TestHeartbeatAckJSON(t *testing.T) {
	tests := []struct {
		name       string
		thresholds settings.Settings
		pending    Pending
		want       string
	}{
		{
			name:       "defaults, nothing pending: serde's 900.0 and an explicit null",
			thresholds: defaultThresholds,
			pending:    Pending{},
			want: `{"loadThresholdVa":900.0,"tripThresholdVa":980.0,"tempThresholdC":40.0,` +
				`"relayCommand":null,"recloseDelaySeconds":30,"tripConfirmSeconds":3,"relayCommandId":null}`,
		},
		{
			name:       "an open command handed over",
			thresholds: defaultThresholds,
			pending:    Pending{Command: CommandOpen, ID: 7},
			want: `{"loadThresholdVa":900.0,"tripThresholdVa":980.0,"tempThresholdC":40.0,` +
				`"relayCommand":"open","recloseDelaySeconds":30,"tripConfirmSeconds":3,"relayCommandId":7}`,
		},
		{
			name: "fractional thresholds and a close",
			thresholds: settings.Settings{
				LoadThresholdVA: 850.5, TripThresholdVA: 975.25, TempThresholdC: 38.7,
				RecloseDelaySeconds: 600, TripConfirmSeconds: 1,
			},
			pending: Pending{Command: CommandClose, ID: 1},
			want: `{"loadThresholdVa":850.5,"tripThresholdVa":975.25,"tempThresholdC":38.7,` +
				`"relayCommand":"close","recloseDelaySeconds":600,"tripConfirmSeconds":1,"relayCommandId":1}`,
		},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			got, err := json.Marshal(NewHeartbeatAck(tt.thresholds, tt.pending))
			if err != nil {
				t.Fatal(err)
			}
			if string(got) != tt.want {
				t.Errorf("got  %s\nwant %s", got, tt.want)
			}
		})
	}
}

// TestHeartbeatAckCarriesWhatTheFirmwareParses checks the ack against the keys and
// value types BackendClient::postHeartbeat reads. A missing key would not fail on
// the board: it would silently fall back (NAN thresholds, zero waits, no command),
// so this is the only place the mismatch would show.
func TestHeartbeatAckCarriesWhatTheFirmwareParses(t *testing.T) {
	firmware := map[string]string{
		"loadThresholdVa":     "number", // ack["loadThresholdVa"] | NAN
		"tripThresholdVa":     "number", // ack["tripThresholdVa"] | NAN
		"tempThresholdC":      "number", // ack["tempThresholdC"] | NAN
		"relayCommand":        "string", // ack["relayCommand"] | "", then strcmp "open"/"close"
		"recloseDelaySeconds": "uint",   // ack["recloseDelaySeconds"] | 0UL
		"tripConfirmSeconds":  "uint",   // ack["tripConfirmSeconds"] | 0UL
		"relayCommandId":      "uint",   // ack["relayCommandId"] | 0, echoed as relayCommandAck
	}

	for _, command := range []Command{CommandOpen, CommandClose} {
		raw, err := json.Marshal(NewHeartbeatAck(defaultThresholds, Pending{Command: command, ID: 3}))
		if err != nil {
			t.Fatal(err)
		}
		var ack map[string]any
		if err := json.Unmarshal(raw, &ack); err != nil {
			t.Fatal(err)
		}

		if got, want := slices.Sorted(maps.Keys(ack)), slices.Sorted(maps.Keys(firmware)); !slices.Equal(got, want) {
			t.Fatalf("ack keys %v, firmware parses %v", got, want)
		}
		for key, kind := range firmware {
			switch v := ack[key].(type) {
			case float64:
				if kind == "string" {
					t.Errorf("%s is a number, firmware expects a string", key)
				}
				// The board reads the waits as unsigned long; zero means "not sent".
				if kind == "uint" && (v <= 0 || v != float64(int64(v))) {
					t.Errorf("%s = %v, firmware expects a positive integer", key, v)
				}
			case string:
				if kind != "string" {
					t.Errorf("%s is a string, firmware expects a %s", key, kind)
				}
				if v != "open" && v != "close" {
					t.Errorf("%s = %q, firmware only acts on open or close", key, v)
				}
			default:
				t.Errorf("%s has type %T", key, v)
			}
		}
	}
}
