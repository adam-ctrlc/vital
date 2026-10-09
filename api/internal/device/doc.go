// Package device is the API's side of the ESP32 that switches and meters the
// transformer.
//
// The board only ever speaks outward: it posts readings and a heartbeat, and
// anything the API wants it to know rides back on the response. That gives this
// package three jobs:
//
//   - record the telemetry the firmware self-reports on its heartbeat, and answer
//     with the operator's thresholds so an edit made while the board was offline
//     still reaches it;
//   - hold an operator's relay command until the board acknowledges it (or, for
//     firmware that does not acknowledge, hand it over exactly once), dropping one
//     that waits longer than CommandLifetime;
//   - describe the link for the admin Settings screen, letting the relay position
//     expire with the link rather than reporting a stale CLOSED forever.
//
// The board is already flashed, so the wire shapes here are a contract with
// firmware that cannot change: field names, null rather than omitted fields, and
// the "open"/"close" vocabulary are all load bearing.
package device
