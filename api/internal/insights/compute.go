package insights

import (
	"math"
	"sort"
	"time"

	"github.com/adam-ctrlc/vital/api/internal/wire"
)

// Time weighting: a reading stands for the time until the next reading of its feed,
// up to maxWeight, so a gap in the data is not filled with a stale value. The last
// reading of a feed stands for lastWeight.
const (
	maxWeight  = 60 * time.Second
	lastWeight = 5 * time.Second

	// loadedW is the real power above which the transformer counts as loaded; below
	// it the power factor of a near-idle line means nothing.
	loadedW = 10.0
	// lowPowerFactor is the level under which a loaded power factor counts as low.
	lowPowerFactor = 0.85
	// targetPowerFactor is what the capacitor in the suggested correction reaches.
	targetPowerFactor = 0.95
	// sagRatio and swellRatio bound normal voltage, as fractions of the nominal.
	sagRatio   = 0.9
	swellRatio = 1.1
	maxEvents  = 20
	maxAlerts  = 500

	// IEEE C57.91: insulation ages at the normal rate at a 110 °C hot spot, with a
	// normal life of 180 000 hours.
	agingMethod      = "IEEE C57.91"
	referenceTempC   = 110
	normalLifeHours  = 180000
	defaultFrequency = 60.0
)

// sample is one stored reading. NaN marks a measurement the board did not give.
type sample struct {
	source      string
	at          time.Time
	voltage     float64
	va          float64
	power       float64
	powerFactor float64
	frequency   float64
	energy      float64
	tempC       float64
	overload    bool
}

// alert is one alert row with the name of whoever acknowledged it.
type alert struct {
	id             int64
	kind           string
	value          float64
	threshold      float64
	createdAt      time.Time
	acknowledgedAt *time.Time
	responseMs     *int64
	ackedBy        *string // user id
	ackedByName    *string
}

// input is everything compute needs. samples must be ordered by source, then time.
type input struct {
	rng        Range
	ratePerKwh float64
	nominalV   float64
	samples    []sample
	alerts     []alert // newest first
}

// Insights is the response of GET /insights.
type Insights struct {
	From         string       `json:"from"`
	To           string       `json:"to"`
	Source       string       `json:"source"`
	Samples      int          `json:"samples"`
	Energy       Energy       `json:"energy"`
	Heatmap      []HeatCell   `json:"heatmap"`
	PowerQuality PowerQuality `json:"powerQuality"`
	Aging        Aging        `json:"aging"`
	Alerts       AlertSummary `json:"alerts"`
}

// Energy is consumption and cost over the range.
type Energy struct {
	RatePerKwh      wire.Float  `json:"ratePerKwh"`
	TotalKwh        wire.Float  `json:"totalKwh"`
	TotalCost       wire.Float  `json:"totalCost"`
	PeakVa          *wire.Float `json:"peakVa"`
	PeakAt          *wire.Time  `json:"peakAt"`
	OverloadMinutes wire.Float  `json:"overloadMinutes"`
	Days            []EnergyDay `json:"days"`
}

// EnergyDay is one Manila day; days without readings are present with zeros and nulls.
type EnergyDay struct {
	Date            string      `json:"date"`
	Kwh             wire.Float  `json:"kwh"`
	Cost            wire.Float  `json:"cost"`
	AvgVa           *wire.Float `json:"avgVa"`
	PeakVa          *wire.Float `json:"peakVa"`
	OverloadMinutes wire.Float  `json:"overloadMinutes"`
	Samples         int         `json:"samples"`
}

// HeatCell is one weekday and hour (Monday = 0, Manila time) that has readings.
type HeatCell struct {
	Weekday         int         `json:"weekday"`
	Hour            int         `json:"hour"`
	AvgVa           *wire.Float `json:"avgVa"`
	MaxVa           *wire.Float `json:"maxVa"`
	OverloadMinutes wire.Float  `json:"overloadMinutes"`
	Samples         int         `json:"samples"`
}

// PowerQuality is voltage against the nominal, and the loaded power factor.
type PowerQuality struct {
	NominalVoltageV       wire.Float     `json:"nominalVoltageV"`
	MinVoltageV           *wire.Float    `json:"minVoltageV"`
	AvgVoltageV           *wire.Float    `json:"avgVoltageV"`
	MaxVoltageV           *wire.Float    `json:"maxVoltageV"`
	SagMinutes            wire.Float     `json:"sagMinutes"`
	SwellMinutes          wire.Float     `json:"swellMinutes"`
	Events                []VoltageEvent `json:"events"`
	AvgPowerFactor        *wire.Float    `json:"avgPowerFactor"`
	LowPowerFactorMinutes wire.Float     `json:"lowPowerFactorMinutes"`
	Correction            *Correction    `json:"correction"`
}

// VoltageEvent is a run of readings below 90% (sag) or above 110% (swell) of nominal.
type VoltageEvent struct {
	At              wire.Time  `json:"at"`
	Kind            string     `json:"kind"`
	VoltageV        wire.Float `json:"voltageV"`
	DurationSeconds int64      `json:"durationSeconds"`
}

// Correction sizes the capacitor that would lift the loaded power factor to 0.95.
type Correction struct {
	TargetPowerFactor wire.Float `json:"targetPowerFactor"`
	BasisPowerW       wire.Float `json:"basisPowerW"`
	BasisPowerFactor  wire.Float `json:"basisPowerFactor"`
	Kvar              wire.Float `json:"kvar"`
	CapacitorUf       wire.Float `json:"capacitorUf"`
}

// Aging estimates insulation aging from the measured temperature, used as the
// hot-spot temperature (the board has no hot-spot sensor).
type Aging struct {
	Method          string      `json:"method"`
	ReferenceTempC  int         `json:"referenceTempC"`
	NormalLifeHours int         `json:"normalLifeHours"`
	AvgAgingFactor  *wire.Float `json:"avgAgingFactor"`
	MaxAgingFactor  *wire.Float `json:"maxAgingFactor"`
	AvgTempC        *wire.Float `json:"avgTempC"`
	MaxTempC        *wire.Float `json:"maxTempC"`
	EquivalentHours wire.Float  `json:"equivalentHours"`
	PeriodHours     wire.Float  `json:"periodHours"`
	LifeUsedPercent wire.Float  `json:"lifeUsedPercent"`
	Days            []AgingDay  `json:"days"`
}

// AgingDay is one Manila day's average aging factor and hottest reading.
type AgingDay struct {
	Date        string      `json:"date"`
	AgingFactor *wire.Float `json:"agingFactor"`
	MaxTempC    *wire.Float `json:"maxTempC"`
}

// AlertSummary is the alerts raised in the range and how quickly people answered.
type AlertSummary struct {
	Total                 int              `json:"total"`
	Overload              int              `json:"overload"`
	Temperature           int              `json:"temperature"`
	Unacknowledged        int              `json:"unacknowledged"`
	MedianResponseSeconds *wire.Float      `json:"medianResponseSeconds"`
	ByPerson              []PersonResponse `json:"byPerson"`
	Rows                  []AlertRow       `json:"rows"`
}

// PersonResponse is one person's acknowledgements in the range.
type PersonResponse struct {
	UserID                string      `json:"userId"`
	Name                  string      `json:"name"`
	Count                 int         `json:"count"`
	MedianResponseSeconds *wire.Float `json:"medianResponseSeconds"`
}

// AlertRow is one alert, for the report's table.
type AlertRow struct {
	ID                 int64      `json:"id"`
	Kind               string     `json:"kind"`
	Value              wire.Float `json:"value"`
	Threshold          wire.Float `json:"threshold"`
	CreatedAt          wire.Time  `json:"createdAt"`
	AcknowledgedAt     *wire.Time `json:"acknowledgedAt"`
	ResponseMs         *int64     `json:"responseMs"`
	AcknowledgedByName *string    `json:"acknowledgedByName"`
}

// mean is a running time-weighted average.
type mean struct{ sum, weight float64 }

func (m *mean) add(v, w float64) {
	if !math.IsNaN(v) {
		m.sum += v * w
		m.weight += w
	}
}

func (m mean) value() float64 {
	if m.weight == 0 {
		return math.NaN()
	}
	return m.sum / m.weight
}

// extreme tracks a maximum (or, with low, a minimum) and when it was reached.
type extreme struct {
	v   float64
	at  time.Time
	low bool
	set bool
}

func (e *extreme) add(v float64, at time.Time) {
	if math.IsNaN(v) {
		return
	}
	if !e.set || (e.low && v < e.v) || (!e.low && v > e.v) {
		e.v, e.at, e.set = v, at, true
	}
}

func (e extreme) value() float64 {
	if !e.set {
		return math.NaN()
	}
	return e.v
}

type dayAcc struct {
	kwh, overloadS float64
	va             mean
	peak           extreme
	samples        int
	aging          mean
	maxTemp        extreme
}

type cellAcc struct {
	va        mean
	peak      extreme
	overloadS float64
	samples   int
}

// agingFactor is IEEE C57.91's F_AA at hot-spot temperature tempC.
func agingFactor(tempC float64) float64 {
	return math.Exp(15000.0/383.0 - 15000.0/(tempC+273.0))
}

func compute(in input) Insights {
	days := in.rng.Days()
	dayAccs := make([]dayAcc, days)
	cells := map[[2]int]*cellAcc{}

	var (
		overloadS, kwh         float64
		peak                   extreme
		volts                  mean
		minV                   = extreme{low: true}
		maxV                   extreme
		sagS, swellS           float64
		pf, loadedPower        mean
		lowPfS                 float64
		freq                   mean
		temp                   mean
		maxTemp                extreme
		eqHours, observedHours float64
		events                 []VoltageEvent
		run                    *voltageRun
		sagLimit, swellLimit   = in.nominalV * sagRatio, in.nominalV * swellRatio
		prevSource             string
		prevEnergy             = math.NaN()
	)

	closeRun := func() {
		if run != nil {
			events = append(events, run.event())
			run = nil
		}
	}

	for i, s := range in.samples {
		var (
			next     *sample
			weight   = lastWeight
			sameFeed = i+1 < len(in.samples) && in.samples[i+1].source == s.source
		)
		if sameFeed {
			next = &in.samples[i+1]
			weight = min(next.at.Sub(s.at), maxWeight)
		}
		w := weight.Seconds()
		local := s.at.In(manila)
		d := int(midnight(local).Sub(in.rng.Start()).Hours()/24 + 0.5)
		if d < 0 || d >= days {
			continue // outside the range; the query should never return one
		}
		day := &dayAccs[d]
		cell := cells[[2]int{(int(local.Weekday()) + 6) % 7, local.Hour()}]
		if cell == nil {
			cell = &cellAcc{}
			cells[[2]int{(int(local.Weekday()) + 6) % 7, local.Hour()}] = cell
		}

		day.samples++
		cell.samples++
		day.va.add(s.va, w)
		cell.va.add(s.va, w)
		day.peak.add(s.va, s.at)
		cell.peak.add(s.va, s.at)
		peak.add(s.va, s.at)
		if s.overload {
			overloadS += w
			day.overloadS += w
			cell.overloadS += w
		}

		// Energy: the meter's counter only goes up; a drop is a reset, not negative use.
		// The delta belongs to the day of the later reading, and is taken from the last
		// reading of the same feed that had a count, so one missed read loses nothing.
		if s.source != prevSource {
			prevSource, prevEnergy = s.source, math.NaN()
		}
		// A reading without a voltage is a meter that did not answer; older firmware sent
		// zeros for the rest of it, and a counter "returning" from that zero would count
		// its whole value again.
		if !math.IsNaN(s.energy) && !math.IsNaN(s.voltage) {
			if delta := s.energy - prevEnergy; delta > 0 {
				kwh += delta
				day.kwh += delta
			}
			prevEnergy = s.energy
		}

		volts.add(s.voltage, w)
		minV.add(s.voltage, s.at)
		maxV.add(s.voltage, s.at)
		kind := ""
		switch {
		case math.IsNaN(s.voltage):
		case s.voltage < sagLimit:
			kind, sagS = "sag", sagS+w
		case s.voltage > swellLimit:
			kind, swellS = "swell", swellS+w
		}
		if run != nil && (kind != run.kind || s.source != run.source || s.at.Sub(run.lastAt) > maxWeight) {
			closeRun()
		}
		if kind != "" {
			if run == nil {
				run = &voltageRun{kind: kind, source: s.source, start: s.at, extreme: s.voltage, nominal: in.nominalV}
			}
			run.add(s.voltage, s.at, w)
		}

		freq.add(s.frequency, w)
		if !math.IsNaN(s.power) && s.power >= loadedW && !math.IsNaN(s.powerFactor) {
			pf.add(s.powerFactor, w)
			loadedPower.add(s.power, w)
			if s.powerFactor < lowPowerFactor {
				lowPfS += w
			}
		}

		if !math.IsNaN(s.tempC) {
			f := agingFactor(s.tempC)
			hours := w / 3600
			eqHours += f * hours
			observedHours += hours
			temp.add(s.tempC, w)
			maxTemp.add(s.tempC, s.at)
			day.aging.add(f, w)
			day.maxTemp.add(s.tempC, s.at)
		}
	}
	closeRun()

	out := Insights{
		From:    in.rng.From.Format(dateLayout),
		To:      in.rng.To.Format(dateLayout),
		Source:  in.rng.Source,
		Samples: len(in.samples),
	}

	// Energy
	out.Energy = Energy{
		RatePerKwh:      wire.Float(in.ratePerKwh),
		TotalKwh:        wire.Float(round(kwh, 4)),
		TotalCost:       wire.Float(round(kwh*in.ratePerKwh, 2)),
		PeakVa:          opt(peak.value(), 1),
		OverloadMinutes: wire.Float(round(overloadS/60, 1)),
		Days:            make([]EnergyDay, days),
	}
	if peak.set {
		out.Energy.PeakAt = &wire.Time{Time: peak.at}
	}
	out.Aging.Days = make([]AgingDay, days)
	for d := range days {
		acc := dayAccs[d]
		date := in.rng.Start().AddDate(0, 0, d).Format(dateLayout)
		out.Energy.Days[d] = EnergyDay{
			Date:            date,
			Kwh:             wire.Float(round(acc.kwh, 4)),
			Cost:            wire.Float(round(acc.kwh*in.ratePerKwh, 2)),
			AvgVa:           opt(acc.va.value(), 1),
			PeakVa:          opt(acc.peak.value(), 1),
			OverloadMinutes: wire.Float(round(acc.overloadS/60, 1)),
			Samples:         acc.samples,
		}
		out.Aging.Days[d] = AgingDay{Date: date, AgingFactor: optSig(acc.aging.value(), 4), MaxTempC: opt(acc.maxTemp.value(), 1)}
	}

	// Heatmap
	out.Heatmap = make([]HeatCell, 0, len(cells))
	for key, c := range cells {
		out.Heatmap = append(out.Heatmap, HeatCell{
			Weekday: key[0], Hour: key[1],
			AvgVa: opt(c.va.value(), 1), MaxVa: opt(c.peak.value(), 1),
			OverloadMinutes: wire.Float(round(c.overloadS/60, 1)),
			Samples:         c.samples,
		})
	}
	sort.Slice(out.Heatmap, func(i, j int) bool {
		a, b := out.Heatmap[i], out.Heatmap[j]
		return a.Weekday < b.Weekday || (a.Weekday == b.Weekday && a.Hour < b.Hour)
	})

	// Power quality
	sort.SliceStable(events, func(i, j int) bool {
		return deviation(events[i], in.nominalV) > deviation(events[j], in.nominalV)
	})
	if len(events) > maxEvents {
		events = events[:maxEvents]
	}
	if events == nil {
		events = []VoltageEvent{}
	}
	out.PowerQuality = PowerQuality{
		NominalVoltageV:       wire.Float(in.nominalV),
		MinVoltageV:           opt(minV.value(), 1),
		AvgVoltageV:           opt(volts.value(), 1),
		MaxVoltageV:           opt(maxV.value(), 1),
		SagMinutes:            wire.Float(round(sagS/60, 1)),
		SwellMinutes:          wire.Float(round(swellS/60, 1)),
		Events:                events,
		AvgPowerFactor:        opt(pf.value(), 3),
		LowPowerFactorMinutes: wire.Float(round(lowPfS/60, 1)),
		Correction:            correction(pf.value(), loadedPower.value(), freq.value(), in.nominalV),
	}

	// Aging
	out.Aging.Method = agingMethod
	out.Aging.ReferenceTempC = referenceTempC
	out.Aging.NormalLifeHours = normalLifeHours
	out.Aging.AvgTempC = opt(temp.value(), 1)
	out.Aging.MaxTempC = opt(maxTemp.value(), 1)
	out.Aging.EquivalentHours = wire.Float(roundSig(eqHours, 4))
	out.Aging.PeriodHours = wire.Float(float64(days * 24))
	out.Aging.LifeUsedPercent = wire.Float(roundSig(eqHours/normalLifeHours*100, 4))
	if observedHours > 0 {
		out.Aging.AvgAgingFactor = optSig(eqHours/observedHours, 4)
		out.Aging.MaxAgingFactor = optSig(agingFactor(maxTemp.value()), 4)
	}

	out.Alerts = summarizeAlerts(in.alerts)
	return out
}

// voltageRun is a sag or swell in progress.
type voltageRun struct {
	kind, source string
	start        time.Time
	lastAt       time.Time
	extreme      float64
	seconds      float64
	nominal      float64
}

func (r *voltageRun) add(v float64, at time.Time, w float64) {
	if (r.kind == "sag" && v < r.extreme) || (r.kind == "swell" && v > r.extreme) {
		r.extreme = v
	}
	r.lastAt = at
	r.seconds += w
}

func (r *voltageRun) event() VoltageEvent {
	return VoltageEvent{
		At: wire.Time{Time: r.start}, Kind: r.kind,
		VoltageV: wire.Float(round(r.extreme, 1)), DurationSeconds: int64(math.Round(r.seconds)),
	}
}

func deviation(e VoltageEvent, nominal float64) float64 {
	return math.Abs(float64(e.VoltageV)-nominal) / nominal
}

// correction sizes a capacitor for the loaded power factor, or nil when it is already
// at or above the target or there is no loaded reading to base it on.
func correction(powerFactor, powerW, frequency, nominalV float64) *Correction {
	if math.IsNaN(powerFactor) || math.IsNaN(powerW) || powerFactor >= targetPowerFactor || powerFactor <= 0 {
		return nil
	}
	if math.IsNaN(frequency) || frequency <= 0 {
		frequency = defaultFrequency
	}
	kvar := powerW * (math.Tan(math.Acos(powerFactor)) - math.Tan(math.Acos(targetPowerFactor))) / 1000
	uf := kvar * 1e3 / (2 * math.Pi * frequency * nominalV * nominalV) * 1e6
	return &Correction{
		TargetPowerFactor: targetPowerFactor,
		BasisPowerW:       wire.Float(round(powerW, 1)),
		BasisPowerFactor:  wire.Float(round(powerFactor, 3)),
		Kvar:              wire.Float(round(kvar, 3)),
		CapacitorUf:       wire.Float(round(uf, 1)),
	}
}

func summarizeAlerts(alerts []alert) AlertSummary {
	out := AlertSummary{Total: len(alerts), ByPerson: []PersonResponse{}, Rows: []AlertRow{}}
	var all []float64
	type person struct {
		name      string
		count     int
		responses []float64
	}
	people := map[string]*person{}
	for _, a := range alerts {
		switch a.kind {
		case "overload":
			out.Overload++
		case "temperature":
			out.Temperature++
		}
		if a.acknowledgedAt == nil {
			out.Unacknowledged++
		}
		if a.responseMs != nil {
			all = append(all, float64(*a.responseMs)/1000)
		}
		if a.ackedBy != nil && a.ackedByName != nil {
			p := people[*a.ackedBy]
			if p == nil {
				p = &person{name: *a.ackedByName}
				people[*a.ackedBy] = p
			}
			p.count++
			if a.responseMs != nil {
				p.responses = append(p.responses, float64(*a.responseMs)/1000)
			}
		}
		if len(out.Rows) < maxAlerts {
			row := AlertRow{
				ID: a.id, Kind: a.kind, Value: wire.Float(a.value), Threshold: wire.Float(a.threshold),
				CreatedAt: wire.Time{Time: a.createdAt}, ResponseMs: a.responseMs, AcknowledgedByName: a.ackedByName,
			}
			if a.acknowledgedAt != nil {
				row.AcknowledgedAt = &wire.Time{Time: *a.acknowledgedAt}
			}
			out.Rows = append(out.Rows, row)
		}
	}
	out.MedianResponseSeconds = opt(median(all), 1)
	for id, p := range people {
		out.ByPerson = append(out.ByPerson, PersonResponse{
			UserID: id, Name: p.name, Count: p.count, MedianResponseSeconds: opt(median(p.responses), 1),
		})
	}
	sort.Slice(out.ByPerson, func(i, j int) bool {
		a, b := out.ByPerson[i], out.ByPerson[j]
		return a.Count > b.Count || (a.Count == b.Count && a.Name < b.Name)
	})
	return out
}

func median(values []float64) float64 {
	if len(values) == 0 {
		return math.NaN()
	}
	sorted := append([]float64(nil), values...)
	sort.Float64s(sorted)
	mid := len(sorted) / 2
	if len(sorted)%2 == 1 {
		return sorted[mid]
	}
	return (sorted[mid-1] + sorted[mid]) / 2
}

func round(v float64, places int) float64 {
	p := math.Pow(10, float64(places))
	return math.Round(v*p) / p
}

// roundSig rounds to significant digits, for factors far below one.
func roundSig(v float64, digits int) float64 {
	if v == 0 || math.IsNaN(v) || math.IsInf(v, 0) {
		return v
	}
	places := digits - int(math.Ceil(math.Log10(math.Abs(v))))
	return round(v, places)
}

// opt is a nullable rounded value: nil for NaN.
func opt(v float64, places int) *wire.Float {
	if math.IsNaN(v) {
		return nil
	}
	return wire.Ptr(round(v, places))
}

func optSig(v float64, digits int) *wire.Float {
	if math.IsNaN(v) {
		return nil
	}
	return wire.Ptr(roundSig(v, digits))
}
