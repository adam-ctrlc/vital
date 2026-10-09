package alerts

import (
	"github.com/google/uuid"

	"github.com/adam-ctrlc/vital/api/internal/wire"
)

// Kind is what an alert is about.
type Kind string

// The two kinds the schema's check constraint admits.
const (
	KindOverload    Kind = "overload"
	KindTemperature Kind = "temperature"
)

// Valid reports whether k is one of the kinds the schema admits. The match is exact:
// "Overload" is not a kind.
func (k Kind) Valid() bool {
	return k == KindOverload || k == KindTemperature
}

// Alert is an alert as the API returns it.
//
// Nullable fields are pointers without omitempty: serde writes Option::None as null,
// so every key is always present.
type Alert struct {
	ID             int64      `json:"id"`
	ReadingID      *int64     `json:"readingId"`
	Kind           Kind       `json:"kind"`
	Message        string     `json:"message"`
	Value          wire.Float `json:"value"`
	Threshold      wire.Float `json:"threshold"`
	CreatedAt      wire.Time  `json:"createdAt"`
	AcknowledgedAt *wire.Time `json:"acknowledgedAt"`
	AcknowledgedBy *uuid.UUID `json:"acknowledgedBy"`
	ResponseMS     *int64     `json:"responseMs"`
}

// AlertWithReading is an alert together with the measurements of the reading that
// triggered it.
//
// The alert stores only the value that crossed and the threshold it crossed, so
// answering "how did it get there" means joining the reading. Every measurement is
// optional twice over: the join is a left join because an alert outlives its reading,
// and a board without a PZEM reports only some fields even when the reading is there.
// Either way the key is present and null, never absent.
//
// The embedded Alert's fields are flattened into the same JSON object, ahead of the
// measurements, matching the Rust field order.
type AlertWithReading struct {
	Alert

	VoltageV        *wire.Float `json:"voltageV"`
	CurrentA        *wire.Float `json:"currentA"`
	TemperatureC    *wire.Float `json:"temperatureC"`
	ApparentPowerVA *wire.Float `json:"apparentPowerVa"`
	PowerW          *wire.Float `json:"powerW"`
	PowerFactor     *wire.Float `json:"powerFactor"`
	FrequencyHz     *wire.Float `json:"frequencyHz"`
	EnergyKWh       *wire.Float `json:"energyKwh"`
}
