package readings

// Input is a raw measurement, either simulated or pushed by hardware.
//
// Every field is optional: a board may carry only a temperature sensor, or only the
// electrical sensors, and still report what it has. A missing value stays missing
// all the way out rather than defaulting to zero.
type Input struct {
	VoltageV     *float64 `json:"voltageV"`
	CurrentA     *float64 `json:"currentA"`
	TemperatureC *float64 `json:"temperatureC"`
	PowerW       *float64 `json:"powerW"`
	PowerFactor  *float64 `json:"powerFactor"`
	FrequencyHz  *float64 `json:"frequencyHz"`
	EnergyKwh    *float64 `json:"energyKwh"`
	// RelayClosed is whether the relay was passing load when this was measured.
	// Reported by the board rather than inferred, because zero amps cannot tell an
	// open contact from a load that is simply switched off.
	RelayClosed *bool `json:"relayClosed"`
}

// ingestBody is what the board posts: the measurement, plus the highest relay command
// id it has applied. RelayCommandAck is absent from firmware that does not acknowledge.
type ingestBody struct {
	Input
	RelayCommandAck *int64 `json:"relayCommandAck"`
}

// IsEmpty reports whether the input carries no measurement at all.
//
// A row of nothing but nulls is not a reading, it is a timestamp. Stored, it would
// count toward the log's total and drag every trend average toward a value nobody
// measured. The relay position is deliberately ignored: a contact state is not a
// measurement of the transformer.
func (in Input) IsEmpty() bool {
	return in.VoltageV == nil &&
		in.CurrentA == nil &&
		in.TemperatureC == nil &&
		in.PowerW == nil &&
		in.PowerFactor == nil &&
		in.FrequencyHz == nil &&
		in.EnergyKwh == nil
}

// inputFrom recovers the measurement a stored reading was made from, for serving the
// newest hardware reading as the live value.
func inputFrom(r Reading) Input {
	return Input{
		VoltageV:     unwire(r.VoltageV),
		CurrentA:     unwire(r.CurrentA),
		TemperatureC: unwire(r.TemperatureC),
		PowerW:       unwire(r.PowerW),
		PowerFactor:  unwire(r.PowerFactor),
		FrequencyHz:  unwire(r.FrequencyHz),
		EnergyKwh:    unwire(r.EnergyKwh),
		RelayClosed:  r.RelayClosed,
	}
}
