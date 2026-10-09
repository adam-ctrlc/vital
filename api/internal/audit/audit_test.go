package audit

import (
	"encoding/json"
	"testing"

	"github.com/adam-ctrlc/vital/api/internal/wire"
)

func TestChangesRecordOnlyDifferences(t *testing.T) {
	s := func(v string) *string { return &v }
	c := Changes{}
	c.Add("same", 900, 900)
	c.Add("samePointer", s("a"), s("a"))
	c.Add("bothNil", (*string)(nil), (*string)(nil))
	c.Add("cleared", s("a@b.c"), (*string)(nil))
	c.Add("set", (*string)(nil), s("x"))
	c.Add("float", wire.Float(900), wire.Float(950.5))
	b, _ := json.Marshal(c)
	want := `{"cleared":{"from":"a@b.c","to":null},"float":{"from":900.0,"to":950.5},"set":{"from":null,"to":"x"}}`
	if string(b) != want {
		t.Errorf("changes = %s\nwant      %s", b, want)
	}
}

func TestEmptyChangesHaveNoDetail(t *testing.T) {
	if !isEmptyChanges(Changes{}) || isEmptyChanges(Changes{"a": {}}) || isEmptyChanges(nil) {
		t.Error("isEmptyChanges")
	}
}
