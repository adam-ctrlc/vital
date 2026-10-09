package readings

// The statements this package runs. Placeholders are ?1, ?2, ... so one argument can
// be read several times; they are still positional, so binds go in numeric order.
//
// Timestamps are RFC 3339 text in UTC with milliseconds and a Z, so they sort as text
// in time order and `order by recorded_at desc` still rides the index.

// readingColumns are the columns every reading is decoded from, in decode order.
// Shared by every statement that returns a reading, so a select list and its decoder
// are one fact rather than several that must be kept in agreement.
const readingColumns = "id, voltage_v, current_a, temperature_c, apparent_power_va, " +
	"status, source, power_w, power_factor, frequency_hz, energy_kwh, relay_closed, " +
	"load_threshold_va, trip_threshold_va, temp_threshold_c, recorded_at"

// insertReadingSQL stores a reading. recorded_at is left to the column default.
//
// Binds: ?1 voltage_v, ?2 current_a, ?3 temperature_c, ?4 apparent_power_va,
// ?5 status, ?6 source, ?7 power_w, ?8 power_factor, ?9 frequency_hz,
// ?10 energy_kwh, ?11 relay_closed (0, 1 or NULL), ?12 load_threshold_va,
// ?13 trip_threshold_va, ?14 temp_threshold_c.
//
// The returned row must be drained before the connection is reused: over HTTP a
// half-read result set leaves the stream unusable ("stream not found"), and ingest
// goes on to evaluate alerts on the same connection.
const insertReadingSQL = `insert into readings
    (voltage_v, current_a, temperature_c, apparent_power_va, status, source,
     power_w, power_factor, frequency_hz, energy_kwh, relay_closed,
     load_threshold_va, trip_threshold_va, temp_threshold_c)
 values (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14)
 returning ` + readingColumns

// recordSampleSQL stores a simulator sample at most once per interval, however many
// dashboards ask at the same moment.
//
// The check and the insert are one statement because SQLite admits one writer at a
// time: a second caller's guard sees the first caller's row and inserts nothing. A
// row comes back only to the request that wrote it, so only that request evaluates
// alerts. Scoped to the simulator feed, so a hardware row never suppresses sampling.
//
// Binds: ?1 voltage_v, ?2 current_a, ?3 temperature_c, ?4 apparent_power_va,
// ?5 status, ?6 power_w, ?7 power_factor, ?8 frequency_hz, ?9 energy_kwh,
// ?10 relay_closed, ?11 the window from sampleWindowModifier, ?12 load_threshold_va,
// ?13 trip_threshold_va, ?14 temp_threshold_c.
const recordSampleSQL = `insert into readings
    (voltage_v, current_a, temperature_c, apparent_power_va, status, source,
     power_w, power_factor, frequency_hz, energy_kwh, relay_closed,
     load_threshold_va, trip_threshold_va, temp_threshold_c)
 select ?1, ?2, ?3, ?4, ?5, 'simulator', ?6, ?7, ?8, ?9, ?10, ?12, ?13, ?14
 where not exists (
     select 1 from readings
     where source = 'simulator'
       and recorded_at > strftime('%Y-%m-%dT%H:%M:%fZ', 'now', ?11)
 )
 returning ` + readingColumns

// latestHardwareSQL is the newest reading a board pushed.
const latestHardwareSQL = "select " + readingColumns +
	" from readings where source = 'hardware' order by recorded_at desc limit 1"

// liveStateSQL loads everything the live endpoint needs in one round trip: the
// settings row, the newest simulator sample as whole-second epoch milliseconds (or
// NULL), and the board's last reported LAN address (or NULL).
//
// Columns: load_threshold_va, trip_threshold_va, temp_threshold_c,
// reclose_delay_seconds, trip_confirm_seconds, source_mode, updated_at,
// latest_simulator_ms, device_ip. No row is an upstream error, not "no settings".
const liveStateSQL = `select s.load_threshold_va, s.trip_threshold_va, s.temp_threshold_c, s.reclose_delay_seconds,
        s.trip_confirm_seconds, s.source_mode, s.updated_at,
        (select strftime('%s', recorded_at) * 1000
         from readings where source = 'simulator'
         order by recorded_at desc limit 1) as latest_simulator_ms,
        (select ip_address from device_telemetry where id = 1) as device_ip
 from settings s
 where s.id = 1`

// historyFilter is the WHERE clause behind both the count and the page, so total
// can never promise a number the rows do not match.
//
// Binds (see HistoryFilter.FilterArgs): ?1 status, ?2 LIKE-escaped needle, ?3 source,
// ?4 from, ?5 to, ?6 minVa, ?7 maxVa, ?8 minTempC. Each is NULL when absent.
//
// LIKE is already case-insensitive for ASCII in SQLite; escape '\' is spelled out on
// every clause because SQLite has no default escape character. The searchable
// timestamp is rendered at UTC+8 so a search matches what the app shows.
const historyFilter = `(?1 is null or status = ?1)
       and (?2 is null
            or status like '%' || ?2 || '%' escape '\'
            or source like '%' || ?2 || '%' escape '\'
            or cast(cast(round(apparent_power_va) as integer) as text)
               like '%' || ?2 || '%' escape '\'
            or strftime('%Y-%m-%d %H:%M', recorded_at, '+8 hours')
               like '%' || ?2 || '%' escape '\')
       and (?3 is null or source = ?3)
       and (?4 is null or recorded_at >= ?4)
       and (?5 is null or recorded_at < ?5)
       and (?6 is null or apparent_power_va >= ?6)
       and (?7 is null or apparent_power_va <= ?7)
       and (?8 is null or temperature_c >= ?8)`

// historyCountSQL counts every row the filter matches, not just one page of them.
const historyCountSQL = "select count(*) from readings where " + historyFilter

// The page query around its ORDER BY; see HistoryFilter.SelectSQL. ?9 is the limit
// and ?10 the offset.
const (
	historySelectPrefix = "select " + readingColumns + " from readings\n where " + historyFilter + "\n order by "
	historySelectSuffix = "\n limit ?9 offset ?10"
)

// trendSQL buckets readings by UTC day, newest window only. The day is selected as a
// full midnight instant rather than a bare date, so the JSON is the shape date_trunc
// produced on Postgres. ?1 is trendWindowModifier's "-N days".
//
// Columns: day, avg_power_va, max_power_va, avg_temperature_c, samples.
const trendSQL = `select strftime('%Y-%m-%dT00:00:00.000Z', recorded_at) as day,
        avg(apparent_power_va) as avg_power_va,
        max(apparent_power_va) as max_power_va,
        avg(temperature_c) as avg_temperature_c,
        count(*) as samples
 from readings
 where recorded_at >= strftime('%Y-%m-%dT%H:%M:%fZ', 'now', ?1)
 group by 1
 order by 1`
