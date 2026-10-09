package alerts

import (
	"database/sql"
	"errors"
	"fmt"
	"testing"

	"github.com/adam-ctrlc/vital/api/internal/httpx"
	"github.com/adam-ctrlc/vital/api/internal/wire"
)

// fakeRow hands back fixed column values the way a driver would, nil for NULL.
type fakeRow struct {
	values []any
	err    error
}

func (f fakeRow) Scan(dest ...any) error {
	if f.err != nil {
		return f.err
	}
	if len(dest) != len(f.values) {
		return fmt.Errorf("scan: %d destinations for %d columns", len(dest), len(f.values))
	}
	for i, d := range dest {
		switch d := d.(type) {
		case sql.Scanner:
			if err := d.Scan(f.values[i]); err != nil {
				return err
			}
		case *int64:
			*d = f.values[i].(int64)
		case *float64:
			*d = f.values[i].(float64)
		case *string:
			*d = f.values[i].(string)
		default:
			return fmt.Errorf("unsupported destination %T", d)
		}
	}
	return nil
}

func openRow() []any {
	return []any{int64(3), nil, "overload", "Load reached 950 VA", 950.0, 900.0,
		"2026-08-14T05:00:00.123Z", nil, nil, nil}
}

func ackedRow() []any {
	return []any{int64(4), int64(11), "temperature", "Temperature reached 41.0 °C", 41.0, 40.0,
		"2026-08-14T05:00:00.000Z", "2026-08-14T05:02:00.250Z",
		"{6F9619FF-8B86-D011-B42D-00C04FC964FF}", int64(120000)}
}

func TestScanAlert(t *testing.T) {
	t.Run("open alert", func(t *testing.T) {
		a, err := ScanAlert(fakeRow{values: openRow()})
		if err != nil {
			t.Fatal(err)
		}
		if a.ID != 3 || a.ReadingID != nil || a.Kind != KindOverload || a.Value != 950 ||
			a.Threshold != 900 || a.AcknowledgedAt != nil || a.AcknowledgedBy != nil || a.ResponseMS != nil {
			t.Errorf("unexpected alert %+v", a)
		}
		if got := a.CreatedAt.UTC().Format("2006-01-02T15:04:05.000Z"); got != "2026-08-14T05:00:00.123Z" {
			t.Errorf("createdAt = %s", got)
		}
	})

	t.Run("acknowledged alert normalises the stored uuid", func(t *testing.T) {
		a, err := ScanAlert(fakeRow{values: ackedRow()})
		if err != nil {
			t.Fatal(err)
		}
		if a.ReadingID == nil || *a.ReadingID != 11 {
			t.Errorf("readingId = %v", a.ReadingID)
		}
		if a.AcknowledgedBy == nil || a.AcknowledgedBy.String() != "6f9619ff-8b86-d011-b42d-00c04fc964ff" {
			t.Errorf("acknowledgedBy = %v", a.AcknowledgedBy)
		}
		if a.AcknowledgedAt == nil || a.AcknowledgedAt.Nanosecond() != 250_000_000 {
			t.Errorf("acknowledgedAt = %v", a.AcknowledgedAt)
		}
		if a.ResponseMS == nil || *a.ResponseMS != 120000 {
			t.Errorf("responseMs = %v", a.ResponseMS)
		}
	})

	broken := func(i int, v any) []any {
		row := ackedRow()
		row[i] = v
		return row
	}
	scanErr := errors.New("driver went away")

	failures := []struct {
		name   string
		row    fakeRow
		stored bool
	}{
		{"bad created_at", fakeRow{values: broken(6, "2026-08-14 05:00:00")}, true},
		{"bad acknowledged_at", fakeRow{values: broken(7, "yesterday")}, true},
		{"bad acknowledged_by", fakeRow{values: broken(8, "not-a-uuid")}, true},
		{"scan failure", fakeRow{err: scanErr}, false},
	}
	for _, tt := range failures {
		t.Run(tt.name, func(t *testing.T) {
			_, err := ScanAlert(tt.row)
			if err == nil {
				t.Fatal("expected an error")
			}
			var apiErr *httpx.Error
			if got := errors.As(err, &apiErr) && apiErr.Status == 502; got != tt.stored {
				t.Errorf("502 upstream = %v, want %v (%v)", got, tt.stored, err)
			}
			if !tt.stored && !errors.Is(err, scanErr) {
				t.Errorf("scan error not wrapped: %v", err)
			}
		})
	}
}

func TestScanAlertWithReading(t *testing.T) {
	t.Run("pruned reading leaves every measurement nil", func(t *testing.T) {
		row := append(openRow(), nil, nil, nil, nil, nil, nil, nil, nil)
		a, err := ScanAlertWithReading(fakeRow{values: row})
		if err != nil {
			t.Fatal(err)
		}
		for name, m := range map[string]*wire.Float{
			"voltage": a.VoltageV, "current": a.CurrentA, "temperature": a.TemperatureC,
			"apparent": a.ApparentPowerVA, "power": a.PowerW, "factor": a.PowerFactor,
			"frequency": a.FrequencyHz, "energy": a.EnergyKWh,
		} {
			if m != nil {
				t.Errorf("%s = %v, want nil", name, *m)
			}
		}
	})

	t.Run("partial reading keeps each field's own presence", func(t *testing.T) {
		row := append(ackedRow(), 230.5, 4.0, nil, 950.0, nil, 0.9, 60.0, nil)
		a, err := ScanAlertWithReading(fakeRow{values: row})
		if err != nil {
			t.Fatal(err)
		}
		if a.ID != 4 || a.AcknowledgedBy == nil {
			t.Errorf("alert fields not read: %+v", a.Alert)
		}
		if a.VoltageV == nil || *a.VoltageV != 230.5 || a.CurrentA == nil || *a.CurrentA != 4 ||
			a.TemperatureC != nil || a.ApparentPowerVA == nil || *a.ApparentPowerVA != 950 ||
			a.PowerW != nil || a.PowerFactor == nil || *a.PowerFactor != 0.9 ||
			a.FrequencyHz == nil || *a.FrequencyHz != 60 || a.EnergyKWh != nil {
			t.Errorf("unexpected measurements %+v", a)
		}
	})
}
