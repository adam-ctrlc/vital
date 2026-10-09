package alerts

import (
	"encoding/json"
	"testing"
	"time"

	"github.com/google/uuid"

	"github.com/adam-ctrlc/vital/api/internal/httpx"
	"github.com/adam-ctrlc/vital/api/internal/wire"
)

func ptr[T any](v T) *T { return &v }

func at(raw string) wire.Time {
	t, err := time.Parse(time.RFC3339Nano, raw)
	if err != nil {
		panic(err)
	}
	return wire.Time{Time: t}
}

func TestAlertJSON(t *testing.T) {
	tests := []struct {
		name string
		in   any
		want string
	}{
		{
			name: "open alert writes every optional key as null",
			in: Alert{
				ID: 7, Kind: KindOverload, Message: "Load reached 950 VA",
				Value: 950, Threshold: 900, CreatedAt: at("2026-08-14T05:00:00.120Z"),
			},
			want: `{"id":7,"readingId":null,"kind":"overload","message":"Load reached 950 VA",` +
				`"value":950.0,"threshold":900.0,"createdAt":"2026-08-14T05:00:00.120Z",` +
				`"acknowledgedAt":null,"acknowledgedBy":null,"responseMs":null}`,
		},
		{
			name: "acknowledged alert",
			in: Alert{
				ID: 8, ReadingID: ptr(int64(42)), Kind: KindTemperature,
				Message: "Temperature reached 41.5 °C", Value: 41.5, Threshold: 40,
				CreatedAt:      at("2026-08-14T05:00:00.000Z"),
				AcknowledgedAt: ptr(at("2026-08-14T05:03:00.500Z")),
				AcknowledgedBy: ptr(uuid.MustParse("6F9619FF-8B86-D011-B42D-00C04FC964FF")),
				ResponseMS:     ptr(int64(180000)),
			},
			want: `{"id":8,"readingId":42,"kind":"temperature","message":"Temperature reached 41.5 °C",` +
				`"value":41.5,"threshold":40.0,"createdAt":"2026-08-14T05:00:00Z",` +
				`"acknowledgedAt":"2026-08-14T05:03:00.500Z",` +
				`"acknowledgedBy":"6f9619ff-8b86-d011-b42d-00c04fc964ff","responseMs":180000}`,
		},
		{
			name: "alert whose reading is gone has every measurement null",
			in: AlertWithReading{Alert: Alert{
				ID: 1, Kind: KindOverload, Message: "m", Value: 1, Threshold: 1,
				CreatedAt: at("2026-08-14T05:00:00Z"),
			}},
			want: `{"id":1,"readingId":null,"kind":"overload","message":"m","value":1.0,` +
				`"threshold":1.0,"createdAt":"2026-08-14T05:00:00Z","acknowledgedAt":null,` +
				`"acknowledgedBy":null,"responseMs":null,"voltageV":null,"currentA":null,` +
				`"temperatureC":null,"apparentPowerVa":null,"powerW":null,"powerFactor":null,` +
				`"frequencyHz":null,"energyKwh":null}`,
		},
		{
			name: "alert with its reading follows the alert fields with the measurements",
			in: AlertWithReading{
				Alert: Alert{
					ID: 2, ReadingID: ptr(int64(9)), Kind: KindOverload, Message: "m",
					Value: 950, Threshold: 900, CreatedAt: at("2026-08-14T05:00:00Z"),
				},
				VoltageV: wire.Ptr(230.1), CurrentA: wire.Ptr(4), ApparentPowerVA: wire.Ptr(950),
				PowerFactor: wire.Ptr(0.95),
			},
			want: `{"id":2,"readingId":9,"kind":"overload","message":"m","value":950.0,` +
				`"threshold":900.0,"createdAt":"2026-08-14T05:00:00Z","acknowledgedAt":null,` +
				`"acknowledgedBy":null,"responseMs":null,"voltageV":230.1,"currentA":4.0,` +
				`"temperatureC":null,"apparentPowerVa":950.0,"powerW":null,"powerFactor":0.95,` +
				`"frequencyHz":null,"energyKwh":null}`,
		},
		{
			name: "empty page lists no rows as an empty array",
			in:   httpx.NewPage([]AlertWithReading(nil), 0, 20, 0),
			want: `{"rows":[],"total":0,"limit":20,"offset":0}`,
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			got, err := json.Marshal(tt.in)
			if err != nil {
				t.Fatal(err)
			}
			if string(got) != tt.want {
				t.Errorf("got  %s\nwant %s", got, tt.want)
			}
		})
	}
}

func TestKindValid(t *testing.T) {
	tests := []struct {
		kind Kind
		want bool
	}{
		{KindOverload, true},
		{KindTemperature, true},
		{"Overload", false},
		{"", false},
		{"voltage", false},
	}
	for _, tt := range tests {
		if got := tt.kind.Valid(); got != tt.want {
			t.Errorf("Kind(%q).Valid() = %v, want %v", tt.kind, got, tt.want)
		}
	}
}
