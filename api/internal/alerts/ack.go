package alerts

import "time"

// responseMillis is the response time SQLAcknowledgeAlert stores, stated in Go so the
// rule is pinned by a test: whole epoch seconds on both sides (strftime('%s') floors
// the fraction), subtracted, times 1000. Two instants 0.9 s apart can therefore
// record 0 or 1000 depending on where the second boundary falls. The statement, not
// this function, is what the API runs, against the database's clock.
func responseMillis(createdAt, acknowledgedAt time.Time) int64 {
	return (acknowledgedAt.Unix() - createdAt.Unix()) * 1000
}
