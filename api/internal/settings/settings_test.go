package settings

import (
	"encoding/json"
	"testing"
	"time"

	"github.com/adam-ctrlc/vital/api/internal/wire"
)

func TestValidate(t *testing.T) {
	i := func(v int32) *int32 { return &v }
	f := func(v float64) *float64 { return &v }
	ok := Update{LoadThresholdVA: 900, TripThresholdVA: 980, TempThresholdC: 40, RecloseDelaySeconds: 30}

	tests := []struct {
		name   string
		mutate func(*Update)
		want   string
	}{
		{"ok", func(*Update) {}, ""},
		{"ok with trip delay", func(u *Update) { u.TripConfirmSeconds = i(60) }, ""},
		{"zero load", func(u *Update) { u.LoadThresholdVA = 0 }, "load threshold must be greater than zero"},
		{"zero temp", func(u *Update) { u.TempThresholdC = 0 }, "temperature threshold must be greater than zero"},
		{"trip equals alarm", func(u *Update) { u.TripThresholdVA = 900 }, "trip threshold must be greater than the alarm threshold"},
		{"reclose too short", func(u *Update) { u.RecloseDelaySeconds = 4 }, "reclose delay must be between 5 and 600 seconds"},
		{"reclose too long", func(u *Update) { u.RecloseDelaySeconds = 601 }, "reclose delay must be between 5 and 600 seconds"},
		{"trip delay zero", func(u *Update) { u.TripConfirmSeconds = i(0) }, "trip delay must be between 1 and 60 seconds"},
		{"trip delay 61", func(u *Update) { u.TripConfirmSeconds = i(61) }, "trip delay must be between 1 and 60 seconds"},
		{"free energy", func(u *Update) { u.EnergyRatePerKwh = f(0) }, ""},
		{"rate 1000", func(u *Update) { u.EnergyRatePerKwh = f(1000) }, ""},
		{"negative rate", func(u *Update) { u.EnergyRatePerKwh = f(-0.01) }, "energy rate must be between 0 and 1000 per kWh"},
		{"rate over 1000", func(u *Update) { u.EnergyRatePerKwh = f(1000.5) }, "energy rate must be between 0 and 1000 per kWh"},
		{"nominal 50", func(u *Update) { u.NominalVoltageV = f(50) }, ""},
		{"nominal 500", func(u *Update) { u.NominalVoltageV = f(500) }, ""},
		{"nominal 49", func(u *Update) { u.NominalVoltageV = f(49.9) }, "nominal voltage must be between 50 and 500 V"},
		{"nominal 501", func(u *Update) { u.NominalVoltageV = f(501) }, "nominal voltage must be between 50 and 500 V"},
	}
	for _, tt := range tests {
		u := ok
		tt.mutate(&u)
		err := u.Validate()
		got := ""
		if err != nil {
			got = err.Error()
		}
		if got != tt.want {
			t.Errorf("%s: %q, want %q", tt.name, got, tt.want)
		}
	}
}

func TestSettingsJSONShape(t *testing.T) {
	at, _ := wire.ParseTime("2026-08-14T05:00:00.120Z")
	b, err := json.Marshal(Settings{
		LoadThresholdVA: 900, TripThresholdVA: 980, TempThresholdC: 40.5,
		RecloseDelaySeconds: 30, TripConfirmSeconds: 3, SourceMode: "hardware",
		EnergyRatePerKwh: 12, NominalVoltageV: 120,
		UpdatedAt: wire.Time{Time: at.In(time.UTC)},
	})
	if err != nil {
		t.Fatal(err)
	}
	want := `{"loadThresholdVa":900.0,"tripThresholdVa":980.0,"tempThresholdC":40.5,"recloseDelaySeconds":30,"tripConfirmSeconds":3,"sourceMode":"hardware","energyRatePerKwh":12.0,"nominalVoltageV":120.0,"updatedAt":"2026-08-14T05:00:00.120Z"}`
	if string(b) != want {
		t.Errorf("got  %s\nwant %s", b, want)
	}
}
