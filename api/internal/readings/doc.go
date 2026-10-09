// Package readings is the measurement feed: the live dashboard value, hardware
// ingest, the paged reading log and the daily trend.
//
// A reading is either simulated (derived from the clock, see Simulate) or pushed by
// a board. Every measurement is optional end to end: a board reports what its
// sensors can read, and a missing value stays null rather than turning into zero.
//
// This file set holds the pure half of the port: evaluation against thresholds,
// simulation, validation, query resolution, the SQL and the JSON shapes. The HTTP
// handlers and the store that runs the SQL sit on top of the shared db, httpx and
// auth packages.
package readings
