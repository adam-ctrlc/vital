// Package alerts opens, lists and acknowledges threshold alerts.
//
// An alert records that a reading crossed the load (overload) or temperature
// threshold. At most one alert per kind is open (unacknowledged) at a time, which the
// partial unique index alerts_one_active_per_kind enforces; an ongoing condition is
// re-announced against that same alert every RenotifyAfterSeconds instead of opening
// a new one.
//
// Routes: GET /api/v1/alerts (paged list with the triggering reading's measurements)
// and POST /api/v1/alerts/{id}/ack, both for any signed-in caller. Service.Evaluate is
// what ingest calls for every stored reading.
package alerts
