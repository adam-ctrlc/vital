package alerts

import (
	"context"
	"errors"
	"reflect"
	"testing"
)

// fakeStore models the alerts table closely enough to drive raise: at most one open
// alert per kind, and whether it is due for re-announcement.
type fakeStore struct {
	open     map[Kind]Alert
	due      map[Kind]bool
	loseRace bool // Open behaves as if the partial unique index refused the insert
	failOn   string

	calls  []string
	opened []Condition
	nextID int64
}

func (s *fakeStore) ClaimRenotify(_ context.Context, kind Kind, after int64) (Alert, bool, error) {
	s.calls = append(s.calls, "claim "+string(kind))
	if after != RenotifyAfterSeconds {
		panic("claim with the wrong interval")
	}
	if s.failOn == "claim" {
		return Alert{}, false, errors.New("claim failed")
	}
	a, ok := s.open[kind]
	if !ok || !s.due[kind] {
		return Alert{}, false, nil
	}
	s.due[kind] = false
	return a, true, nil
}

func (s *fakeStore) ActiveID(_ context.Context, kind Kind) (int64, bool, error) {
	s.calls = append(s.calls, "active "+string(kind))
	if s.failOn == "active" {
		return 0, false, errors.New("active failed")
	}
	a, ok := s.open[kind]
	return a.ID, ok, nil
}

func (s *fakeStore) Open(_ context.Context, readingID int64, c Condition) (Alert, bool, error) {
	s.calls = append(s.calls, "open "+string(c.Kind))
	if s.failOn == "open" {
		return Alert{}, false, errors.New("open failed")
	}
	if s.loseRace {
		return Alert{}, false, nil
	}
	s.opened = append(s.opened, c)
	s.nextID++
	a := Alert{ID: s.nextID, ReadingID: &readingID, Kind: c.Kind, Message: c.Message}
	if s.open == nil {
		s.open = map[Kind]Alert{}
	}
	s.open[c.Kind] = a
	return a, true, nil
}

type fakeNotifier struct{ told []int64 }

func (n *fakeNotifier) NotifyAlert(_ context.Context, a Alert) { n.told = append(n.told, a.ID) }

func TestEvaluate(t *testing.T) {
	limits := Thresholds{LoadVA: 900, TempC: 40}
	overload := Measurement{ReadingID: 5, ApparentPowerVA: f(950)}
	both := Measurement{ReadingID: 5, ApparentPowerVA: f(950), TemperatureC: f(45)}
	openOverload := map[Kind]Alert{KindOverload: {ID: 77, Kind: KindOverload, Message: "Load reached 920 VA"}}

	tests := []struct {
		name      string
		store     *fakeStore
		m         Measurement
		wantErr   bool
		wantCalls []string
		wantTold  []int64
		wantOpen  []Condition
	}{
		{
			name:  "below threshold touches nothing",
			store: &fakeStore{},
			m:     Measurement{ReadingID: 5, ApparentPowerVA: f(100)},
		},
		{
			name:      "new condition opens an alert and announces it",
			store:     &fakeStore{},
			m:         overload,
			wantCalls: []string{"claim overload", "active overload", "open overload"},
			wantTold:  []int64{1},
			wantOpen:  []Condition{{KindOverload, "Load reached 950 VA", 950, 900}},
		},
		{
			name:      "ongoing condition that is due is announced again on the same alert",
			store:     &fakeStore{open: openOverload, due: map[Kind]bool{KindOverload: true}},
			m:         overload,
			wantCalls: []string{"claim overload"},
			wantTold:  []int64{77},
		},
		{
			name:      "ongoing condition announced too recently stays quiet",
			store:     &fakeStore{open: openOverload, due: map[Kind]bool{}},
			m:         overload,
			wantCalls: []string{"claim overload", "active overload"},
		},
		{
			name:      "losing the insert race to a concurrent request is not an error",
			store:     &fakeStore{loseRace: true},
			m:         overload,
			wantCalls: []string{"claim overload", "active overload", "open overload"},
		},
		{
			name:      "each kind is raised independently, overload first",
			store:     &fakeStore{open: openOverload, due: map[Kind]bool{}},
			m:         both,
			wantCalls: []string{"claim overload", "active overload", "claim temperature", "active temperature", "open temperature"},
			wantTold:  []int64{1},
			wantOpen:  []Condition{{KindTemperature, "Temperature reached 45.0 °C", 45, 40}},
		},
		{
			name:      "a store failure stops evaluation",
			store:     &fakeStore{failOn: "claim"},
			m:         both,
			wantErr:   true,
			wantCalls: []string{"claim overload"},
		},
		{
			name:      "active lookup failure is returned",
			store:     &fakeStore{failOn: "active"},
			m:         overload,
			wantErr:   true,
			wantCalls: []string{"claim overload", "active overload"},
		},
		{
			name:      "insert failure other than the race is returned",
			store:     &fakeStore{failOn: "open"},
			m:         overload,
			wantErr:   true,
			wantCalls: []string{"claim overload", "active overload", "open overload"},
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			n := &fakeNotifier{}
			err := NewService(tt.store, n, nil).Evaluate(context.Background(), tt.m, limits)
			if (err != nil) != tt.wantErr {
				t.Fatalf("err = %v, wantErr %v", err, tt.wantErr)
			}
			if !reflect.DeepEqual(tt.store.calls, tt.wantCalls) {
				t.Errorf("calls = %q, want %q", tt.store.calls, tt.wantCalls)
			}
			if !reflect.DeepEqual(n.told, tt.wantTold) {
				t.Errorf("announced %v, want %v", n.told, tt.wantTold)
			}
			if !reflect.DeepEqual(tt.store.opened, tt.wantOpen) {
				t.Errorf("opened %+v, want %+v", tt.store.opened, tt.wantOpen)
			}
		})
	}
}

// A fast heartbeat over one ongoing condition opens one alert and is announced once
// until the renotify interval passes.
func TestEvaluateHeartbeatDoesNotFlood(t *testing.T) {
	store := &fakeStore{due: map[Kind]bool{}}
	n := &fakeNotifier{}
	svc := NewService(store, n, nil)
	m := Measurement{ReadingID: 1, ApparentPowerVA: f(950)}
	limits := Thresholds{LoadVA: 900, TempC: 40}

	for range 5 {
		if err := svc.Evaluate(context.Background(), m, limits); err != nil {
			t.Fatal(err)
		}
	}
	if len(store.opened) != 1 || !reflect.DeepEqual(n.told, []int64{1}) {
		t.Fatalf("opened %d, announced %v; want one of each", len(store.opened), n.told)
	}

	store.due[KindOverload] = true // sixty seconds pass
	if err := svc.Evaluate(context.Background(), m, limits); err != nil {
		t.Fatal(err)
	}
	if len(store.opened) != 1 || !reflect.DeepEqual(n.told, []int64{1, 1}) {
		t.Fatalf("opened %d, announced %v; want the same alert announced again", len(store.opened), n.told)
	}
}
