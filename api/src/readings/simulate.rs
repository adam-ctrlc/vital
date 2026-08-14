use crate::readings::model::ReadingInput;

const NOMINAL_VOLTAGE: f64 = 230.0;
/// The Philippine grid runs at 60 Hz.
const NOMINAL_FREQUENCY: f64 = 60.0;
/// Fixed point the simulated meter counted up from: 2026-07-01T00:00:00Z.
const ENERGY_EPOCH_MS: i64 = 1_782_950_400_000;
/// Rough mean real power, used to accumulate the energy total.
const MEAN_POWER_KW: f64 = 0.65;

/// Derives a smooth, repeatable measurement from the clock.
///
/// Serverless functions cannot keep a background loop alive, so the value is a pure
/// function of time. It drifts across the 900 VA and 40 C thresholds so the dashboard,
/// alerts and logs all exercise realistically without any stored simulator state.
#[must_use]
pub fn at(unix_ms: i64) -> ReadingInput {
    let t = unix_ms as f64 / 1000.0;

    let apparent_power_va =
        720.0 + 190.0 * (t / 37.0).sin() + 70.0 * (t / 11.3).sin() + 18.0 * (t / 2.7).sin();
    let apparent_power_va = apparent_power_va.clamp(0.0, 1400.0);

    let voltage_v = NOMINAL_VOLTAGE + 2.5 * (t / 6.1).sin() + 1.2 * (t / 1.7).sin();
    let current_a = apparent_power_va / voltage_v;

    let temperature_c = 34.0 + 7.0 * (t / 53.0).sin() + 1.5 * (t / 4.3).sin();

    // An inductive load drifting through the range a transformer study cares about.
    let power_factor = (0.90 + 0.05 * (t / 23.0).sin()).clamp(0.0, 1.0);
    let power_w = apparent_power_va * power_factor;

    let frequency_hz = NOMINAL_FREQUENCY + 0.05 * (t / 17.0).sin();

    // Monotonic, like a real meter's running total.
    let hours_since_epoch = ((unix_ms - ENERGY_EPOCH_MS).max(0) as f64) / 3_600_000.0;
    let energy_kwh = hours_since_epoch * MEAN_POWER_KW;

    ReadingInput {
        voltage_v: Some(voltage_v),
        current_a: Some(current_a),
        temperature_c: Some(temperature_c),
        power_w: Some(power_w),
        power_factor: Some(power_factor),
        frequency_hz: Some(frequency_hz),
        energy_kwh: Some(energy_kwh),
        // The simulator has no contacts. Null rather than a guess, so a simulated run
        // never claims a relay position that no relay held.
        relay_closed: None,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn power_factor_stays_within_physical_bounds() {
        for step in 0..500 {
            let input = at(ENERGY_EPOCH_MS + step * 997);
            let pf = input.power_factor.expect("simulator always reports pf");

            assert!((0.0..=1.0).contains(&pf), "power factor out of range: {pf}");
        }
    }

    #[test]
    fn real_power_never_exceeds_apparent_power() {
        for step in 0..500 {
            let input = at(ENERGY_EPOCH_MS + step * 997);
            let voltage = input.voltage_v.expect("simulator always reports voltage");
            let current = input.current_a.expect("simulator always reports current");
            let apparent = voltage * current;
            let real = input.power_w.expect("simulator always reports power");

            assert!(real <= apparent + 1e-6, "P {real} exceeded S {apparent}");
        }
    }

    #[test]
    fn energy_only_counts_up() {
        let mut previous = f64::MIN;

        for step in 0..500 {
            let energy = at(ENERGY_EPOCH_MS + step * 60_000)
                .energy_kwh
                .expect("simulator always reports energy");

            assert!(energy >= previous, "energy went backwards");
            previous = energy;
        }
    }
}
