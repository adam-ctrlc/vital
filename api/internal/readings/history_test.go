package readings

import (
	"math"
	"slices"
	"strings"
	"testing"
)

// an_instant_is_rewritten_in_the_stored_shape, a_blank_or_malformed_instant_is_handled
func TestInstant(t *testing.T) {
	at, err := instant("from", ptr("2026-10-09T00:00:00+08:00"))
	if err != nil || at == nil || *at != "2026-10-08T16:00:00.000Z" {
		t.Fatalf("instant = %v, %v", at, err)
	}
	if at, err := instant("from", ptr("  ")); err != nil || at != nil {
		t.Fatalf("blank instant = %v, %v, want absent", at, err)
	}
	if at, err := instant("from", nil); err != nil || at != nil {
		t.Fatalf("absent instant = %v, %v", at, err)
	}
	_, err = instant("from", ptr("yesterday"))
	wantBadRequest(t, err, "invalid from: expected an RFC 3339 instant")
}

// only_known_sorts_reach_the_query
func TestOrderBy(t *testing.T) {
	tests := []struct {
		sort *string
		want string
	}{
		{nil, "recorded_at desc"},
		{ptr("newest"), "recorded_at desc"},
		{ptr("oldest"), "recorded_at asc"},
		{ptr("load"), "apparent_power_va is null, apparent_power_va desc, recorded_at desc"},
		{ptr("temperature"), "temperature_c is null, temperature_c desc, recorded_at desc"},
	}
	for _, tt := range tests {
		if got, err := orderBy(tt.sort); err != nil || got != tt.want {
			t.Errorf("orderBy(%v) = %q, %v, want %q", tt.sort, got, err, tt.want)
		}
	}
	_, err := orderBy(ptr("recorded_at; drop table readings"))
	wantBadRequest(t, err, "invalid sort: recorded_at; drop table readings")
}

// a_non_finite_bound_is_rejected
func TestBound(t *testing.T) {
	for _, bad := range []float64{math.NaN(), math.Inf(1), math.Inf(-1)} {
		_, err := bound("minVa", &bad)
		wantBadRequest(t, err, "invalid minVa")
	}
	if got, err := bound("minVa", ptr(700.0)); err != nil || got == nil || *got != 700 {
		t.Fatalf("bound(700) = %v, %v", got, err)
	}
	if got, err := bound("minVa", nil); err != nil || got != nil {
		t.Fatalf("bound(nil) = %v, %v", got, err)
	}
}

func TestHistoryQueryResolve(t *testing.T) {
	tests := []struct {
		name string
		q    HistoryQuery
		msg  string // empty means valid
	}{
		{"empty", HistoryQuery{}, ""},
		{"blank filters are absent", HistoryQuery{Status: ptr(" "), Source: ptr(""), Q: ptr("  "), Sort: ptr(" ")}, ""},
		{"trimmed status", HistoryQuery{Status: ptr(" overload ")}, ""},
		{"bad status", HistoryQuery{Status: ptr("broken")}, "invalid status: broken"},
		{"bad source", HistoryQuery{Source: ptr("phone")}, "invalid source: phone"},
		{"bad sort", HistoryQuery{Sort: ptr("id")}, "invalid sort: id"},
		{"bad from", HistoryQuery{From: ptr("monday")}, "invalid from: expected an RFC 3339 instant"},
		{"bad to", HistoryQuery{To: ptr("2026-10-09")}, "invalid to: expected an RFC 3339 instant"},
		{"NaN maxVa", HistoryQuery{MaxVA: ptr(math.NaN())}, "invalid maxVa"},
		{"inf minTempC", HistoryQuery{MinTempC: ptr(math.Inf(1))}, "invalid minTempC"},
		{"min above max", HistoryQuery{MinVA: ptr(900.0), MaxVA: ptr(800.0)}, "minVa is above maxVa"},
		{"min equals max", HistoryQuery{MinVA: ptr(900.0), MaxVA: ptr(900.0)}, ""},
		{"from equals to", HistoryQuery{From: ptr("2026-10-09T00:00:00Z"), To: ptr("2026-10-09T08:00:00+08:00")}, "from is not before to"},
		{"from before to", HistoryQuery{From: ptr("2026-10-09T00:00:00Z"), To: ptr("2026-10-09T00:00:00.001Z")}, ""},
		// Checked in the Rust order: the instants before the bounds before the sort,
		// and the pairwise checks before status and source.
		{"from before minVa", HistoryQuery{From: ptr("x"), MinVA: ptr(math.NaN())}, "invalid from: expected an RFC 3339 instant"},
		{"bound before sort", HistoryQuery{MinVA: ptr(math.NaN()), Sort: ptr("x")}, "invalid minVa"},
		{"sort before range", HistoryQuery{Sort: ptr("x"), MinVA: ptr(2.0), MaxVA: ptr(1.0)}, "invalid sort: x"},
		{"range before status", HistoryQuery{MinVA: ptr(2.0), MaxVA: ptr(1.0), Status: ptr("x")}, "minVa is above maxVa"},
		{"status before source", HistoryQuery{Status: ptr("x"), Source: ptr("y")}, "invalid status: x"},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			_, err := tt.q.Resolve()
			if tt.msg == "" {
				if err != nil {
					t.Fatalf("Resolve = %v, want ok", err)
				}
				return
			}
			wantBadRequest(t, err, tt.msg)
		})
	}
}

func TestHistoryFilterBinds(t *testing.T) {
	f, err := HistoryQuery{
		Status: ptr(" overload "),
		Q:      ptr(" 50%_ "),
		Source: ptr("hardware"),
		From:   ptr("2026-10-09T00:00:00+08:00"),
		MinVA:  ptr(700.0),
		Sort:   ptr("load"),
		Limit:  ptr[int64](900),
		Offset: ptr[int64](-1),
	}.Resolve()
	if err != nil {
		t.Fatal(err)
	}
	want := []any{"overload", `50\%\_`, "hardware", "2026-10-08T16:00:00.000Z", nil, 700.0, nil, nil, int64(500), int64(0)}
	if got := f.SelectArgs(); !slices.Equal(got, want) {
		t.Fatalf("SelectArgs = %#v\nwant %#v", got, want)
	}
	if got := f.FilterArgs(); len(got) != 8 {
		t.Fatalf("FilterArgs has %d binds, want 8", len(got))
	}
	sql := f.SelectSQL()
	if !strings.Contains(sql, "order by "+orderLoad+"\n limit ?9 offset ?10") {
		t.Fatalf("SelectSQL lost its order or paging:\n%s", sql)
	}

	// The zero filter still sorts newest first.
	if !strings.Contains(HistoryFilter{}.SelectSQL(), "order by recorded_at desc\n") {
		t.Fatal("zero filter does not sort newest first")
	}
}
