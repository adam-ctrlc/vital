package alerts

import (
	"errors"
	"net/http/httptest"
	"reflect"
	"testing"

	"github.com/adam-ctrlc/vital/api/internal/httpx"
)

func TestParseListQuery(t *testing.T) {
	tests := []struct {
		name    string
		raw     string
		want    ListQuery
		status  int  // expected error status, 0 for success
		plain   bool // axum rejection (text/plain) rather than {"error": ...}
		message string
	}{
		{name: "defaults", raw: "", want: ListQuery{Limit: 20}},
		{name: "active", raw: "active=true", want: ListQuery{Active: true, Limit: 20}},
		{name: "active false", raw: "active=false", want: ListQuery{Limit: 20}},
		{name: "active must be exact", raw: "active=1", status: 400, plain: true},
		{name: "active is case sensitive", raw: "active=True", status: 400, plain: true},
		{name: "blank active is malformed", raw: "active=", status: 400, plain: true},
		{name: "kind", raw: "kind=temperature", want: ListQuery{Kind: KindTemperature, Limit: 20}},
		{name: "kind is trimmed", raw: "kind=+overload+", want: ListQuery{Kind: KindOverload, Limit: 20}},
		{name: "blank kind is no filter", raw: "kind=%20%20", want: ListQuery{Limit: 20}},
		{name: "unknown kind", raw: "kind=voltage", status: 400, message: "invalid alert kind: voltage"},
		{name: "kind is case sensitive", raw: "kind=Overload", status: 400, message: "invalid alert kind: Overload"},
		{name: "unknown kind reported trimmed", raw: "kind=+x+", status: 400, message: "invalid alert kind: x"},
		{name: "search is trimmed and escaped", raw: "q=+50%25_a%5C+", want: ListQuery{Search: `50\%\_a\\`, Limit: 20}},
		{name: "blank search is no filter", raw: "q=", want: ListQuery{Limit: 20}},
		{name: "limit and offset", raw: "limit=50&offset=40", want: ListQuery{Limit: 50, Offset: 40}},
		{name: "limit clamps to max", raw: "limit=1000", want: ListQuery{Limit: 200}},
		{name: "limit clamps to one", raw: "limit=0", want: ListQuery{Limit: 1}},
		{name: "negative limit clamps to one", raw: "limit=-5", want: ListQuery{Limit: 1}},
		{name: "negative offset clamps to zero", raw: "offset=-3", want: ListQuery{Limit: 20}},
		{name: "non-integer limit", raw: "limit=ten", status: 400, plain: true},
		{name: "blank limit is malformed", raw: "limit=", status: 400, plain: true},
		{name: "fractional offset", raw: "offset=1.5", status: 400, plain: true},
		{name: "malformed query beats a bad kind", raw: "kind=x&limit=x", status: 400, plain: true},
		{name: "unknown params ignored", raw: "page=3&sort=x", want: ListQuery{Limit: 20}},
		{
			name: "everything",
			raw:  "active=true&kind=overload&q=load&limit=5&offset=10",
			want: ListQuery{Active: true, Kind: KindOverload, Search: "load", Limit: 5, Offset: 10},
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			got, err := ParseListQuery(httptest.NewRequest("GET", "/api/v1/alerts?"+tt.raw, nil))
			if tt.status == 0 {
				if err != nil {
					t.Fatal(err)
				}
				if got != tt.want {
					t.Errorf("got %+v, want %+v", got, tt.want)
				}
				return
			}
			var apiErr *httpx.Error
			if !errors.As(err, &apiErr) || apiErr.Status != tt.status || apiErr.Plain != tt.plain {
				t.Fatalf("err = %#v, want status %d plain %v", err, tt.status, tt.plain)
			}
			if tt.message != "" && apiErr.Message != tt.message {
				t.Errorf("message = %q, want %q", apiErr.Message, tt.message)
			}
		})
	}
}

func TestListArgs(t *testing.T) {
	tests := []struct {
		name  string
		q     ListQuery
		count []any
	}{
		{"no filters bind nulls", ListQuery{Limit: 20}, []any{int64(0), nil, nil}},
		{"filters bind values", ListQuery{Active: true, Kind: KindOverload, Search: "x", Limit: 5, Offset: 2},
			[]any{int64(1), "overload", "x"}},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			if got := tt.q.countArgs(); !reflect.DeepEqual(got, tt.count) {
				t.Errorf("countArgs = %#v, want %#v", got, tt.count)
			}
			want := append(append([]any{}, tt.count...), tt.q.Limit, tt.q.Offset)
			if got := tt.q.rowArgs(); !reflect.DeepEqual(got, want) {
				t.Errorf("rowArgs = %#v, want %#v", got, want)
			}
		})
	}
}
