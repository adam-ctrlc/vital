package device

import (
	"github.com/adam-ctrlc/vital/api/internal/settings"
	"github.com/adam-ctrlc/vital/api/internal/wire"
)

// HeartbeatAck is the response to a heartbeat.
//
// The firmware compares the thresholds with its stored values and re-applies only
// when they differ, which is how an edit made while it was offline reaches it. It
// parses these six keys by exactly these names; every key is always present, and
// relayCommand is null when nothing is pending. Field order follows the Rust
// struct so the bytes match the old API.
type HeartbeatAck struct {
	LoadThresholdVA wire.Float `json:"loadThresholdVa"`
	// TripThresholdVA is the level at which the board opens the relay, sent with the
	// alarm level so both stages of the protection come from one operator edit.
	TripThresholdVA wire.Float `json:"tripThresholdVa"`
	TempThresholdC  wire.Float `json:"tempThresholdC"`
	// RelayCommand is what an operator asked for, or null. Firmware that acknowledges
	// gets it until it does; older firmware gets it once (see Store.handover).
	RelayCommand Command `json:"relayCommand"`
	// RecloseDelaySeconds is how long the board waits before each reclose attempt.
	RecloseDelaySeconds int32 `json:"recloseDelaySeconds"`
	// TripConfirmSeconds is how long the load must stay above the trip level before
	// the contacts open.
	TripConfirmSeconds int32 `json:"tripConfirmSeconds"`
	// RelayCommandID identifies RelayCommand for the board to acknowledge, or null.
	RelayCommandID *int64 `json:"relayCommandId"`
}

// NewHeartbeatAck builds the response from the current settings and whatever
// command the heartbeat is handing over (the zero Pending if there is none).
func NewHeartbeatAck(st settings.Settings, pending Pending) HeartbeatAck {
	return HeartbeatAck{
		LoadThresholdVA:     st.LoadThresholdVA,
		TripThresholdVA:     st.TripThresholdVA,
		TempThresholdC:      st.TempThresholdC,
		RelayCommand:        pending.Command,
		RecloseDelaySeconds: st.RecloseDelaySeconds,
		TripConfirmSeconds:  st.TripConfirmSeconds,
		RelayCommandID:      pending.IDOrNil(),
	}
}
