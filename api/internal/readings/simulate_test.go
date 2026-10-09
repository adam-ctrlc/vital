package readings

import (
	"math"
	"testing"
)

// power_factor_stays_within_physical_bounds
func TestSimulatePowerFactorInBounds(t *testing.T) {
	for step := int64(0); step < 500; step++ {
		pf := *Simulate(energyEpochMs + step*997).PowerFactor
		if pf < 0 || pf > 1 {
			t.Fatalf("power factor out of range: %v", pf)
		}
	}
}

// real_power_never_exceeds_apparent_power
func TestSimulateRealPowerWithinApparent(t *testing.T) {
	for step := int64(0); step < 500; step++ {
		in := Simulate(energyEpochMs + step*997)
		apparent := *in.VoltageV * *in.CurrentA
		if real := *in.PowerW; real > apparent+1e-6 {
			t.Fatalf("P %v exceeded S %v", real, apparent)
		}
	}
}

// energy_only_counts_up
func TestSimulateEnergyOnlyCountsUp(t *testing.T) {
	previous := -math.MaxFloat64
	for step := int64(0); step < 500; step++ {
		energy := *Simulate(energyEpochMs + step*60_000).EnergyKwh
		if energy < previous {
			t.Fatalf("energy went backwards at step %d", step)
		}
		previous = energy
	}
}

func TestSimulateNeverReportsARelay(t *testing.T) {
	if in := Simulate(energyEpochMs); in.RelayClosed != nil || in.IsEmpty() {
		t.Fatalf("simulated input = %+v", in)
	}
}

// TestSimulateMatchesRust pins Simulate to the bits the Rust simulate::at returned
// (built with chrono 0.4.45 on darwin/arm64, Rust 1.99), so the Go and Rust APIs
// serve and store the same numbers for the same clock.
func TestSimulateMatchesRust(t *testing.T) {
	// voltage, current, temperature, power, power factor, frequency, energy
	golden := map[int64][7]uint64{
		0:                 {0x406cc00000000000, 0x40090b21642c8591, 0x4041000000000000, 0x4084400000000000, 0x3feccccccccccccd, 0x404e000000000000, 0x0000000000000000},
		1_782_950_400_000: {0x406cbe8eff66cfc3, 0x400dbb46a5b561c9, 0x403fd8d9113d3f8c, 0x4086b3e09925925c, 0x3feb33cc0c36a21c, 0x404dfdcdcc49f201, 0x0000000000000000},
		1_791_504_000_000: {0x406c92af9577ce7f, 0x400707d781e43f91, 0x4042dc9fcd938a79, 0x408183048123fb75, 0x3feb4009aedc936d, 0x404dfa75c81248c2, 0x409821999999999a},
		1_791_504_012_345: {0x406cf2e72103cafa, 0x400721248e37926b, 0x404361974e5e1ab9, 0x408217fa5d1ed9d9, 0x3febabdb1d2e0568, 0x404dfdfc4fc0b757, 0x4098219be1e8762f},
		1_800_000_000_999: {0x406c505b446adbb0, 0x4004018a203d6b84, 0x4044946c64a00c9d, 0x4080d1000fee4634, 0x3fee6663d657f5cc, 0x404dfb3ad2496170, 0x40a80ccce4712e41},
		1_700_000_000_000: {0x406d243b11e417ef, 0x400bc0663ab45492, 0x403b986262cc0760, 0x4087ff5ad3f270c5, 0x3fee62addeb69421, 0x404e05f665bad3ed, 0x0000000000000000},
	}
	names := [7]string{"voltage", "current", "temperature", "power", "power factor", "frequency", "energy"}
	for ms, want := range golden {
		in := Simulate(ms)
		got := [7]float64{*in.VoltageV, *in.CurrentA, *in.TemperatureC, *in.PowerW, *in.PowerFactor, *in.FrequencyHz, *in.EnergyKwh}
		for i := range got {
			if bits := math.Float64bits(got[i]); bits != want[i] {
				t.Errorf("at %d %s = %v (%#016x), Rust gave %v (%#016x)",
					ms, names[i], got[i], bits, math.Float64frombits(want[i]), want[i])
			}
		}
	}
}
