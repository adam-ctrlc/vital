package readings

import "math"

// Sensors report SI units and the database stores those, so conversions are applied
// on the way out rather than at rest. Storing both would let the two drift apart.

// CelsiusToFahrenheit converts degrees Celsius to degrees Fahrenheit: F = C * 9/5 + 32.
//
// Fused, as the Rust original's mul_add was, so the result is bit-identical.
func CelsiusToFahrenheit(celsius float64) float64 {
	return math.FMA(celsius, 9.0/5.0, 32)
}

// FahrenheitToCelsius converts degrees Fahrenheit to degrees Celsius: C = (F - 32) * 5/9.
func FahrenheitToCelsius(fahrenheit float64) float64 {
	return float64(float64(fahrenheit-32)*5) / 9
}
