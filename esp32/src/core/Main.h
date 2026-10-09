#pragma once

#include <Arduino.h>
#include <Preferences.h>

#include "../config/Pins.h"
#include "Monitor.h"
#include "../hardware/Lcd.h"
#include "../hardware/EnergyMeter.h"
#include "../net/LiveServer.h"
#include "../hardware/TemperatureProbe.h"
#include "../hardware/Relay.h"
#include "../net/BackendClient.h"
#include "../net/WifiLink.h"

#define POST_INTERVAL_MS 5000
// How often the board asks for the operator's thresholds and delays. Half a minute is
// fine because these change only when a person changes them: relay commands ride back
// on the reading POST instead, so the app's buttons do not wait on this.
#define HEARTBEAT_INTERVAL_MS 30000
// Reconnection runs on its own cadence. Tied to the heartbeat, a drop just after one
// went out went unattended for the next 29 seconds, which is the whole of the API's
// freshness window, so the dashboard went dark before the board even tried to recover.
#define RECONNECT_INTERVAL_MS 15000
// Posts in a row that got no HTTP answer at all before the link is rejoined. The driver
// can keep reporting connected long after traffic stopped, and until it notices, the
// reconnect above never fires. Three is fifteen seconds of silence, inside the API's
// thirty second freshness window.
#define DEAD_LINK_AFTER_FAILED_POSTS 3

// How long to wait after the contacts move before writing the trip state to NVS.
//
// A flash write is a blocking erase cycle, tens of milliseconds of raised current. Done
// in the same pass that switched the relay, it lands microseconds after the coil inrush,
// and an off press triggers two because the trip and the lockout are stored separately.
// Those spikes on one rail are what makes the contacts hesitate.
//
// The cost is a short window in which a reboot loses the flag, with the contacts already
// in the safe position. That is the smaller risk.
#define PERSIST_SETTLE_MS 300

// Wipes the saved trip, lockout and operator settings once at boot.
//
// A latched trip lives in NVS, so it outlives a reflash: a board that locked out during
// testing comes back locked out and refuses to close, which reads exactly like a dead
// relay. Set this to 1, flash once, then set it back to 0. Left on, it discards the
// operator's thresholds and any genuine trip on every boot.
#define CLEAR_SAVED_STATE 0

// Bounds on what a heartbeat may set the thresholds to. TLS runs without certificate
// validation, so whoever controls DNS or the access point can answer in the backend's
// place, and applyThresholds writes what it accepts to NVS. Sized for a 1 KVA unit with
// room to spare.

#define MIN_LOAD_THRESHOLD_VA 1.0f
#define MAX_LOAD_THRESHOLD_VA 2000.0f
#define MIN_TEMP_THRESHOLD_C 1.0f
#define MAX_TEMP_THRESHOLD_C 150.0f

class Main {
 public:
  Main();

  void begin();

  void loop();

 private:
  void post(unsigned long now);

  // Adopts thresholds from a heartbeat, but only when valid and actually changed, so
  // unchanged heartbeats never wear the flash.
  void applyThresholds(const BackendClient::HeartbeatResult &ack);

  // Kept separate from applyThresholds so one bad threshold does not stop the delays
  // being adopted: the threshold check returns early in several places.
  void applyRecloseDelay(const BackendClient::HeartbeatResult &ack);

  void applyTripConfirm(const BackendClient::HeartbeatResult &ack);

  // Acts on an operator's relay command, whichever request carried it. The backend
  // hands it to exactly one of them, so this does not care which.
  void applyRelayCommand(BackendClient::RelayCommand command, unsigned long now);

  Lcd lcd;
  BackendClient backend;
  WifiLink net;
  EnergyMeter meter;
  TemperatureProbe probe;
  Relay relay;
  Monitor monitor;
  // Declared after the monitor it binds to: members are built in declaration order.
  LiveServer live{monitor};
  Preferences prefs;
  unsigned long lastPost = 0;
  unsigned long lastHeartbeat = 0;
  unsigned long lastReconnect = 0;
  uint8_t unreachedPosts = 0;
  /// A flash write is owed, and the earliest moment it may happen. One per pass, so the
  /// two never land together.
  bool trippedDirty = false;
  bool lockedDirty = false;
  unsigned long persistAt = 0;
  bool tripped = false;
  bool lockedOut = false;
  /// What was last written to NVS, so an unchanged heartbeat does not rewrite it.
  /// Seeded in begin() from what the monitor ended up holding.
  unsigned long recloseSeconds = 0;
  unsigned long tripSeconds = 0;
};
