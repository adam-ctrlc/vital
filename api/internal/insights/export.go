package insights

import (
	"database/sql"
	"encoding/csv"
	"fmt"
	"log/slog"
	"net/http"
	"strconv"

	"github.com/adam-ctrlc/vital/api/internal/httpx"
	"github.com/adam-ctrlc/vital/api/internal/wire"
)

// maxExportRows bounds one download.
const maxExportRows = 500_000

// exportSQL is the readings of the range, oldest first. Binds as samplesSQL, plus ?4
// the row cap.
const exportSQL = `select recorded_at, voltage_v, current_a, apparent_power_va, power_w, power_factor,
       frequency_hz, energy_kwh, temperature_c, status, source, load_threshold_va, trip_threshold_va,
       relay_closed
from readings
where recorded_at >= ?1 and recorded_at < ?2 and (?3 is null or source = ?3)
order by recorded_at, id
limit ?4`

var exportHeader = []string{
	"time", "voltage_v", "current_a", "apparent_power_va", "power_w", "power_factor", "frequency_hz",
	"energy_kwh", "temperature_c", "status", "source", "alarm_va", "trip_va", "relay_closed",
}

// export: GET /readings/export?from&to&source -> CSV, written row by row as it is read.
// Times are Manila local, for a spreadsheet; a missing measurement is an empty cell.
func (h *Handler) export(w http.ResponseWriter, r *http.Request) error {
	rng, err := parseRange(httpx.NewQuery(r), h.now())
	if err != nil {
		return err
	}
	ctx := r.Context()
	rows, err := h.db.QueryContext(ctx, exportSQL, storage(rng.Start()), storage(rng.End()), rng.sourceArg(), maxExportRows)
	if err != nil {
		return fmt.Errorf("export: %w", err)
	}
	defer rows.Close()

	name := fmt.Sprintf("vital-readings-%s-to-%s.csv", rng.From.Format(dateLayout), rng.To.Format(dateLayout))
	w.Header().Set("Content-Type", "text/csv; charset=utf-8")
	w.Header().Set("Content-Disposition", `attachment; filename="`+name+`"`)
	w.WriteHeader(http.StatusOK)

	out := csv.NewWriter(w)
	flusher, _ := w.(http.Flusher)
	_ = out.Write(exportHeader)

	record := make([]string, len(exportHeader))
	written := 0
	for rows.Next() {
		var (
			at, status, source                           string
			volts, amps, va, power, pf, freq, kwh, tempC sql.NullFloat64
			alarm, trip                                  sql.NullFloat64
			relay                                        sql.NullInt64
		)
		if err := rows.Scan(&at, &volts, &amps, &va, &power, &pf, &freq, &kwh, &tempC, &status, &source,
			&alarm, &trip, &relay); err != nil {
			// The status line has gone out, so all that is left is to stop and say why.
			slog.ErrorContext(ctx, "export: read failed", "rows", written, "error", err)
			break
		}
		t, err := wire.ParseTime(at)
		if err != nil {
			slog.ErrorContext(ctx, "export: unreadable timestamp", "value", at, "error", err)
			break
		}
		record[0] = t.In(manila).Format("2006-01-02 15:04:05")
		for i, v := range []sql.NullFloat64{volts, amps, va, power, pf, freq, kwh, tempC} {
			record[1+i] = cell(v)
		}
		record[9], record[10] = status, source
		record[11], record[12] = cell(alarm), cell(trip)
		record[13] = ""
		if relay.Valid {
			record[13] = strconv.FormatBool(relay.Int64 != 0)
		}
		if err := out.Write(record); err != nil {
			return nil // the client went away
		}
		written++
		if written%1000 == 0 {
			out.Flush()
			if flusher != nil {
				flusher.Flush()
			}
		}
	}
	if err := rows.Err(); err != nil {
		slog.ErrorContext(ctx, "export: read failed", "rows", written, "error", err)
	}
	out.Flush()
	return nil
}

func cell(v sql.NullFloat64) string {
	if !v.Valid {
		return ""
	}
	return strconv.FormatFloat(v.Float64, 'f', -1, 64)
}
