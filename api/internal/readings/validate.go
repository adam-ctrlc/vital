package readings

import (
	"strconv"

	"github.com/adam-ctrlc/vital/api/internal/httpx"
)

// measurementRange is a physically plausible envelope for one measurement on a 1 KVA
// transformer on a 230 V / 60 Hz supply, set far above anything the hardware can
// produce. It bounds what gets stored rather than modelling the device: voltage times
// current silently overflows to +Inf once both are large enough, and a stored +Inf
// poisons the alert message, loadPercent and the day's trend bucket for good.
type measurementRange struct {
	field    string
	min, max float64
}

// check rejects an out-of-range measurement. An absent one is always fine: an ingest
// may carry any subset. NaN fails, since it is inside no range.
func (r measurementRange) check(value *float64) error {
	if value == nil {
		return nil
	}
	if v := *value; v >= r.min && v <= r.max {
		return nil
	}
	return httpx.BadRequest("%s must be between %s and %s", r.field, plain(r.min), plain(r.max))
}

// plain renders a bound as Rust's f64 Display does: 1000, not 1000.0 or 1e+03.
func plain(v float64) string {
	return strconv.FormatFloat(v, 'f', -1, 64)
}

// errEmptyReading is refused by both ingest and the store: a reading must measure
// something.
func errEmptyReading() error {
	return httpx.BadRequest("at least one measurement is required")
}

// rangeCheck pairs a measurement with the envelope it must sit in.
type rangeCheck struct {
	measurementRange
	value *float64
}

// ingestChecks lists every envelope, in the order the Rust route checked them.
func ingestChecks(in Input) []rangeCheck {
	return []rangeCheck{
		{measurementRange{"voltage", 0, 1_000}, in.VoltageV},
		{measurementRange{"current", 0, 100}, in.CurrentA},
		{measurementRange{"power", -100_000, 100_000}, in.PowerW},
		{measurementRange{"temperature", -50, 300}, in.TemperatureC},
		{measurementRange{"frequency", 0, 100}, in.FrequencyHz},
		{measurementRange{"energy", 0, 1_000_000}, in.EnergyKwh},
		{measurementRange{"power factor", 0, 1}, in.PowerFactor},
	}
}

// ValidateIngest checks a board's payload before anything touches the database: it
// must carry at least one measurement, and each one present must be in range. The
// first failure is returned.
func ValidateIngest(in Input) error {
	if in.IsEmpty() {
		return errEmptyReading()
	}
	for _, c := range ingestChecks(in) {
		if err := c.check(c.value); err != nil {
			return err
		}
	}
	return nil
}
