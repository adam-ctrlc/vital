package alerts

// The statements behind this package, verbatim from the Rust API apart from
// whitespace. Every statement that returns an alert selects alertColumns (or its
// a.-prefixed twin) in that order, and ScanAlert reads them positionally, so the order
// is defined in one place.
//
// Parameters are numbered (?1, ?2 ...) and bound positionally: the Nth argument is ?N.
//
// Timestamps are written as strftime('%Y-%m-%dT%H:%M:%fZ', 'now'), the format the
// schema's defaults use, so they sort and compare as text. Epoch arithmetic uses
// strftime('%s', ...), which is whole seconds: the only epoch SQLite offers.

const (
	// alertColumns is the column list ScanAlert reads, unprefixed.
	alertColumns = `id, reading_id, kind, message, value, threshold, created_at,
       acknowledged_at, acknowledged_by, response_ms`

	// alertColumnsJoined is alertColumns prefixed with the alerts alias, for the
	// joined list where a bare id or created_at would be ambiguous with readings.
	alertColumnsJoined = `a.id, a.reading_id, a.kind, a.message, a.value, a.threshold, a.created_at,
       a.acknowledged_at, a.acknowledged_by, a.response_ms`

	// readingColumnsJoined are the eight measurements ScanAlertWithReading reads after
	// the alert columns.
	readingColumnsJoined = `r.voltage_v, r.current_a, r.temperature_c, r.apparent_power_va,
       r.power_w, r.power_factor, r.frequency_hz, r.energy_kwh`
)

// The list filter, shared by the count and the window so total covers every match.
//
// ?1 is active as an integer (0 or 1): SQLite stores booleans as integers.
// ?2 is the exact kind or NULL. ?3 is the escaped search needle or NULL.
//
// like replaces Postgres's ilike: SQLite's like is already case insensitive for ASCII.
// The escape clause has to be spelled out, because SQLite has no escape character
// until one is named, and without it the wildcards escapeLike neutralised would be
// wildcards again.
const (
	// SQLCountAlerts counts every alert matching the filters. Args: listArgs.count.
	SQLCountAlerts = `select count(*) from alerts
 where (?1 = 0 or acknowledged_at is null)
   and (?2 is null or kind = ?2)
   and (?3 is null
        or message like '%' || ?3 || '%' escape '\'
        or kind like '%' || ?3 || '%' escape '\')`

	// SQLListAlerts selects one window of matching alerts, newest first, each with
	// its reading's measurements. Left joined, not inner: an alert whose reading has
	// been pruned is still listed, just without the measurements. Args: listArgs.rows.
	SQLListAlerts = `select ` + alertColumnsJoined + `,
       ` + readingColumnsJoined + `
  from alerts a
  left join readings r on r.id = a.reading_id
 where (?1 = 0 or a.acknowledged_at is null)
   and (?2 is null or a.kind = ?2)
   and (?3 is null
        or a.message like '%' || ?3 || '%' escape '\'
        or a.kind like '%' || ?3 || '%' escape '\')
 order by a.created_at desc
 limit ?4 offset ?5`
)

// SQLAcknowledgeAlert acknowledges an open alert and records the response time.
// Args: ?1 the acknowledging user's id as hyphenated lowercase text, ?2 the alert id.
//
// It returns no row when the alert does not exist or is already acknowledged; both
// are a 404. response_ms is whole seconds on both sides times 1000 (see
// responseMillis), and created_at in the SET list is the stored value: SQLite
// evaluates the expressions against the row as it was before the update.
const SQLAcknowledgeAlert = `update alerts
   set acknowledged_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now'),
       acknowledged_by = ?1,
       response_ms = (strftime('%s', 'now') - strftime('%s', created_at)) * 1000,
       updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
 where id = ?2 and acknowledged_at is null
 returning ` + alertColumns

// SQLClaimRenotify claims the right to re-announce the open alert of a kind and
// returns it, in one statement. Args: ?1 kind, ?2 RenotifyAfterSeconds.
//
// The due condition lives in the WHERE clause rather than a preceding read, so two
// concurrent readings cannot both decide they are the one that is due: SQLite admits
// one writer at a time, and whoever runs second matches against the last_notified_at
// the first just wrote and is handed no row. alerts_one_active_per_kind guarantees
// the predicate names at most one row.
const SQLClaimRenotify = `update alerts
   set last_notified_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now'),
       updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
 where kind = ?1
   and acknowledged_at is null
   and (last_notified_at is null
        or strftime('%s', 'now') - strftime('%s', last_notified_at) >= ?2)
 returning ` + alertColumns

// SQLActiveAlertID finds the open alert of a kind, if any. Args: ?1 kind.
const SQLActiveAlertID = `select id from alerts where kind = ?1 and acknowledged_at is null limit 1`

// SQLOpenAlert opens an alert, already marked as announced now so the next
// re-announcement waits RenotifyAfterSeconds. Args: ?1 reading id, ?2 kind,
// ?3 message, ?4 value, ?5 threshold.
//
// A concurrent request that opened the same kind first makes this fail on
// alerts_one_active_per_kind; the store reports that as "not opened", not an error.
const SQLOpenAlert = `insert into alerts (reading_id, kind, message, value, threshold, last_notified_at)
values (?1, ?2, ?3, ?4, ?5, strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
returning ` + alertColumns
