package insights

import (
	"encoding/json"
	"math"
	"strings"
	"testing"
	"time"
)

var nan = math.NaN()

func utc(s string) time.Time {
	t, err := time.Parse(time.RFC3339, s)
	if err != nil {
		panic(err)
	}
	return t
}

func day(s string) time.Time {
	t, _ := time.ParseInLocation(dateLayout, s, manila)
	return t
}

func ptrF(v any) float64 {
	switch p := v.(type) {
	case interface{ MarshalJSON() ([]byte, error) }:
		b, _ := p.MarshalJSON()
		if string(b) == "null" {
			return nan
		}
		var f float64
		_ = json.Unmarshal(b, &f)
		return f
	}
	return nan
}

func near(t *testing.T, name string, got, want float64) {
	t.Helper()
	if math.IsNaN(want) != math.IsNaN(got) || (!math.IsNaN(want) && math.Abs(got-want) > 1e-9) {
		t.Errorf("%s = %v, want %v", name, got, want)
	}
}

// The fixture, hand-worked. Nominal 120 V (sag < 108, swell > 132), rate 10 per kWh.
// Thursday 24 September 2026 23:59:40 Manila is 15:59:40 UTC.
//
//	reading  UTC        weight          V    VA   P    PF   Hz  kWh    °C  status
//	s1       15:59:40   30 s (to s2)    120  100  90   0.9  60  1.000  40  normal    Thu 23h
//	s2       16:00:10   60 s (cap)      100  500  300  0.6  60  1.010  50  overload  Fri 0h
//	s3       16:02:10   10 s (to s4)    105  200  5    0.5  60  0.500  -   normal    Fri 0h
//	s4       16:02:20    5 s (last)     135  -    -    -    -   0.520  60  normal    Fri 0h
func fixture() input {
	return input{
		rng:        Range{From: day("2026-09-24"), To: day("2026-09-25"), Source: "hardware"},
		ratePerKwh: 10,
		nominalV:   120,
		samples: []sample{
			{source: "hardware", at: utc("2026-09-24T15:59:40Z"), voltage: 120, va: 100, power: 90, powerFactor: 0.9, frequency: 60, energy: 1.000, tempC: 40},
			{source: "hardware", at: utc("2026-09-24T16:00:10Z"), voltage: 100, va: 500, power: 300, powerFactor: 0.6, frequency: 60, energy: 1.010, tempC: 50, overload: true},
			{source: "hardware", at: utc("2026-09-24T16:02:10Z"), voltage: 105, va: 200, power: 5, powerFactor: 0.5, frequency: 60, energy: 0.500, tempC: nan},
			{source: "hardware", at: utc("2026-09-24T16:02:20Z"), voltage: 135, va: nan, power: nan, powerFactor: nan, frequency: nan, energy: 0.520, tempC: 60},
		},
	}
}

func TestEnergyAndDays(t *testing.T) {
	got := compute(fixture())
	if got.From != "2026-09-24" || got.To != "2026-09-25" || got.Source != "hardware" || got.Samples != 4 {
		t.Fatalf("header = %+v", got)
	}
	e := got.Energy
	// 1.000 -> 1.010 is +0.010; the drop to 0.500 is a reset and counts nothing;
	// 0.500 -> 0.520 is +0.020. Both deltas land on Friday.
	near(t, "totalKwh", float64(e.TotalKwh), 0.03)
	near(t, "totalCost", float64(e.TotalCost), 0.3)
	near(t, "peakVa", ptrF(e.PeakVa), 500)
	if e.PeakAt == nil || !e.PeakAt.Equal(utc("2026-09-24T16:00:10Z")) {
		t.Errorf("peakAt = %v", e.PeakAt)
	}
	near(t, "overloadMinutes", float64(e.OverloadMinutes), 1)
	if len(e.Days) != 2 || e.Days[0].Date != "2026-09-24" || e.Days[1].Date != "2026-09-25" {
		t.Fatalf("days = %+v", e.Days)
	}
	thu, fri := e.Days[0], e.Days[1]
	near(t, "thu kwh", float64(thu.Kwh), 0)
	near(t, "thu avgVa", ptrF(thu.AvgVa), 100)
	if thu.Samples != 1 || fri.Samples != 3 {
		t.Errorf("samples = %d, %d", thu.Samples, fri.Samples)
	}
	near(t, "fri kwh", float64(fri.Kwh), 0.03)
	near(t, "fri cost", float64(fri.Cost), 0.3)
	// (500*60 + 200*10) / 70; s4 has no VA.
	near(t, "fri avgVa", ptrF(fri.AvgVa), 457.1)
	near(t, "fri peakVa", ptrF(fri.PeakVa), 500)
	near(t, "fri overload", float64(fri.OverloadMinutes), 1)
}

func TestHeatmapUsesManilaWeekdayAndHour(t *testing.T) {
	got := compute(fixture()).Heatmap
	if len(got) != 2 {
		t.Fatalf("heatmap = %+v", got)
	}
	// Thursday is 3 (Monday 0); 23:59 Manila is hour 23 though it is 15:59 UTC.
	if got[0].Weekday != 3 || got[0].Hour != 23 || got[0].Samples != 1 {
		t.Errorf("first cell = %+v", got[0])
	}
	if got[1].Weekday != 4 || got[1].Hour != 0 || got[1].Samples != 3 {
		t.Errorf("second cell = %+v", got[1])
	}
	near(t, "fri 0h avgVa", ptrF(got[1].AvgVa), 457.1)
	near(t, "fri 0h maxVa", ptrF(got[1].MaxVa), 500)
	near(t, "fri 0h overload", float64(got[1].OverloadMinutes), 1)
}

func TestPowerQuality(t *testing.T) {
	pq := compute(fixture()).PowerQuality
	near(t, "nominal", float64(pq.NominalVoltageV), 120)
	near(t, "min", ptrF(pq.MinVoltageV), 100)
	near(t, "max", ptrF(pq.MaxVoltageV), 135)
	// (120*30 + 100*60 + 105*10 + 135*5) / 105 = 107.857...
	near(t, "avg", ptrF(pq.AvgVoltageV), 107.9)
	near(t, "sag minutes", float64(pq.SagMinutes), 1.2)     // 70 s
	near(t, "swell minutes", float64(pq.SwellMinutes), 0.1) // 5 s

	// s2 and s3 are both sags but 120 s apart, so two events, worst first.
	if len(pq.Events) != 3 {
		t.Fatalf("events = %+v", pq.Events)
	}
	want := []struct {
		kind string
		v    float64
		secs int64
		at   string
	}{
		{"sag", 100, 60, "2026-09-24T16:00:10Z"},
		{"sag", 105, 10, "2026-09-24T16:02:10Z"},
		{"swell", 135, 5, "2026-09-24T16:02:20Z"},
	}
	for i, w := range want {
		e := pq.Events[i]
		if e.Kind != w.kind || float64(e.VoltageV) != w.v || e.DurationSeconds != w.secs || !e.At.Equal(utc(w.at)) {
			t.Errorf("event %d = %+v, want %+v", i, e, w)
		}
	}

	// Loaded (P >= 10 W): s1 and s2. PF (0.9*30 + 0.6*60) / 90 = 0.7; P 230 W.
	near(t, "avg pf", ptrF(pq.AvgPowerFactor), 0.7)
	near(t, "low pf minutes", float64(pq.LowPowerFactorMinutes), 1)
	c := pq.Correction
	if c == nil {
		t.Fatal("correction is nil")
	}
	near(t, "target", float64(c.TargetPowerFactor), 0.95)
	near(t, "basis W", float64(c.BasisPowerW), 230)
	near(t, "basis pf", float64(c.BasisPowerFactor), 0.7)
	// 230 * (tan(acos 0.7) - tan(acos 0.95)) / 1000 = 0.15905 kvar;
	// 159.05 / (2π * 60 * 120²) * 1e6 = 29.30 µF.
	near(t, "kvar", float64(c.Kvar), 0.159)
	near(t, "µF", float64(c.CapacitorUf), 29.3)
}

func TestNoCorrectionAtOrAboveTarget(t *testing.T) {
	if c := correction(0.96, 500, 60, 230); c != nil {
		t.Errorf("correction at 0.96 = %+v", c)
	}
	if c := correction(nan, nan, nan, 230); c != nil {
		t.Errorf("correction with nothing loaded = %+v", c)
	}
	// No frequency: 60 Hz is assumed.
	if a, b := correction(0.7, 230, nan, 120), correction(0.7, 230, 60, 120); *a != *b {
		t.Errorf("default frequency: %+v vs %+v", a, b)
	}
}

func TestAging(t *testing.T) {
	near(t, "F_AA at 110 °C", agingFactor(110), 1)
	if agingFactor(117) < 1.95 || agingFactor(117) > 2.1 {
		t.Errorf("F_AA at 117 °C = %v, want about 2 (aging doubles every ~7 K)", agingFactor(117))
	}

	a := compute(fixture()).Aging
	f40, f50, f60 := agingFactor(40), agingFactor(50), agingFactor(60)
	eq := (f40*30 + f50*60 + f60*5) / 3600
	if a.Method != "IEEE C57.91" || a.ReferenceTempC != 110 || a.NormalLifeHours != 180000 {
		t.Errorf("constants = %+v", a)
	}
	near(t, "equivalentHours", float64(a.EquivalentHours), roundSig(eq, 4))
	near(t, "avgAgingFactor", ptrF(a.AvgAgingFactor), roundSig(eq/(95.0/3600), 4))
	near(t, "maxAgingFactor", ptrF(a.MaxAgingFactor), roundSig(f60, 4))
	near(t, "avgTempC", ptrF(a.AvgTempC), 47.4) // (40*30 + 50*60 + 60*5) / 95
	near(t, "maxTempC", ptrF(a.MaxTempC), 60)
	near(t, "periodHours", float64(a.PeriodHours), 48)
	near(t, "lifeUsedPercent", float64(a.LifeUsedPercent), roundSig(eq/180000*100, 4))
	if len(a.Days) != 2 {
		t.Fatalf("aging days = %+v", a.Days)
	}
	near(t, "thu factor", ptrF(a.Days[0].AgingFactor), roundSig(f40, 4))
	near(t, "fri factor", ptrF(a.Days[1].AgingFactor), roundSig((f50*60+f60*5)/65, 4))
	near(t, "fri max", ptrF(a.Days[1].MaxTempC), 60)
}

func TestEmptyRange(t *testing.T) {
	got := compute(input{rng: Range{From: day("2026-09-01"), To: day("2026-09-03"), Source: "all"}, ratePerKwh: 12, nominalV: 230})
	b, err := json.Marshal(got)
	if err != nil {
		t.Fatal(err)
	}
	s := string(b)
	for _, want := range []string{
		`"samples":0`,
		`"energy":{"ratePerKwh":12.0,"totalKwh":0.0,"totalCost":0.0,"peakVa":null,"peakAt":null,"overloadMinutes":0.0,"days":[{"date":"2026-09-01","kwh":0.0,"cost":0.0,"avgVa":null,"peakVa":null,"overloadMinutes":0.0,"samples":0},`,
		`"heatmap":[]`,
		`"powerQuality":{"nominalVoltageV":230.0,"minVoltageV":null,"avgVoltageV":null,"maxVoltageV":null,"sagMinutes":0.0,"swellMinutes":0.0,"events":[],"avgPowerFactor":null,"lowPowerFactorMinutes":0.0,"correction":null}`,
		`"avgAgingFactor":null,"maxAgingFactor":null,"avgTempC":null,"maxTempC":null,"equivalentHours":0.0,"periodHours":72.0,"lifeUsedPercent":0.0`,
		`{"date":"2026-09-03","agingFactor":null,"maxTempC":null}`,
		`"alerts":{"total":0,"overload":0,"temperature":0,"unacknowledged":0,"medianResponseSeconds":null,"byPerson":[],"rows":[]}`,
	} {
		if !strings.Contains(s, want) {
			t.Errorf("missing %s\nin %s", want, s)
		}
	}
}

func TestEnergyIgnoresASilentMeter(t *testing.T) {
	// Older firmware sent energy 0 with no voltage when the meter did not answer. The
	// count "returning" to 0.424 afterwards is not 0.424 kWh of use.
	at := func(s string) time.Time { return utc("2026-09-24T04:00:" + s + "Z") }
	in := input{
		rng: Range{From: day("2026-09-24"), To: day("2026-09-24"), Source: "hardware"}, ratePerKwh: 1, nominalV: 120,
		samples: []sample{
			{source: "hardware", at: at("00"), voltage: 120, energy: 0.423, va: nan, power: nan, powerFactor: nan, frequency: nan, tempC: nan},
			{source: "hardware", at: at("05"), voltage: nan, energy: 0, va: nan, power: nan, powerFactor: nan, frequency: nan, tempC: nan},
			{source: "hardware", at: at("10"), voltage: 120, energy: 0.424, va: nan, power: nan, powerFactor: nan, frequency: nan, tempC: nan},
			{source: "hardware", at: at("15"), voltage: 120, energy: 0.000, va: nan, power: nan, powerFactor: nan, frequency: nan, tempC: nan}, // a real reset
			{source: "hardware", at: at("20"), voltage: 120, energy: 0.002, va: nan, power: nan, powerFactor: nan, frequency: nan, tempC: nan},
		},
	}
	near(t, "kwh", float64(compute(in).Energy.TotalKwh), 0.003)
}

func TestFeedsAreWeightedSeparately(t *testing.T) {
	// The simulator's reading 10 s after the hardware one must not cut the hardware
	// reading's weight, and its energy counter is its own.
	in := input{
		rng: Range{From: day("2026-09-24"), To: day("2026-09-24"), Source: "all"}, ratePerKwh: 1, nominalV: 120,
		samples: []sample{
			{source: "hardware", at: utc("2026-09-24T04:00:00Z"), voltage: 120, va: 100, energy: 5, overload: true, power: nan, powerFactor: nan, frequency: nan, tempC: nan},
			{source: "hardware", at: utc("2026-09-24T04:00:40Z"), voltage: 120, va: 100, energy: 5.5, power: nan, powerFactor: nan, frequency: nan, tempC: nan},
			{source: "simulator", at: utc("2026-09-24T04:00:10Z"), voltage: 120, va: 300, energy: 100, power: nan, powerFactor: nan, frequency: nan, tempC: nan},
			{source: "simulator", at: utc("2026-09-24T04:00:20Z"), voltage: 120, va: 300, energy: 100.25, power: nan, powerFactor: nan, frequency: nan, tempC: nan},
		},
	}
	got := compute(in)
	near(t, "kwh", float64(got.Energy.TotalKwh), 0.75)
	// hardware 40 s overload of 40+5; simulator 10+5.
	near(t, "overload minutes", float64(got.Energy.OverloadMinutes), 0.7)
	// (100*45 + 300*15) / 60 = 150
	near(t, "avgVa", ptrF(got.Energy.Days[0].AvgVa), 150)
}

func TestAlertSummary(t *testing.T) {
	ms := func(v int64) *int64 { return &v }
	str := func(v string) *string { return &v }
	at := utc("2026-09-24T08:00:00Z")
	got := summarizeAlerts([]alert{
		{id: 4, kind: "overload", value: 990, threshold: 900, createdAt: at, acknowledgedAt: &at, responseMs: ms(20000), ackedBy: str("u2"), ackedByName: str("Bea")},
		{id: 3, kind: "overload", value: 950, threshold: 900, createdAt: at},
		{id: 2, kind: "temperature", value: 45, threshold: 40, createdAt: at, acknowledgedAt: &at, responseMs: ms(30000), ackedBy: str("u1"), ackedByName: str("Ann")},
		{id: 1, kind: "overload", value: 920, threshold: 900, createdAt: at, acknowledgedAt: &at, responseMs: ms(10000), ackedBy: str("u1"), ackedByName: str("Ann")},
	})
	if got.Total != 4 || got.Overload != 3 || got.Temperature != 1 || got.Unacknowledged != 1 {
		t.Errorf("counts = %+v", got)
	}
	near(t, "median", ptrF(got.MedianResponseSeconds), 20)
	if len(got.ByPerson) != 2 || got.ByPerson[0].UserID != "u1" || got.ByPerson[0].Count != 2 || got.ByPerson[1].Name != "Bea" {
		t.Fatalf("byPerson = %+v", got.ByPerson)
	}
	near(t, "Ann median", ptrF(got.ByPerson[0].MedianResponseSeconds), 20)
	if len(got.Rows) != 4 || got.Rows[0].ID != 4 || got.Rows[1].AcknowledgedAt != nil || *got.Rows[0].AcknowledgedByName != "Bea" {
		t.Errorf("rows = %+v", got.Rows)
	}
}

func TestRoundSig(t *testing.T) {
	for _, c := range []struct{ in, want float64 }{
		{0.000248123, 0.0002481}, {1.67311e-5, 1.673e-5}, {123456, 123500}, {0, 0},
	} {
		near(t, "roundSig", roundSig(c.in, 4), c.want)
	}
}
