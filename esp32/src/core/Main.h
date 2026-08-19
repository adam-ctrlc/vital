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
// How often the board asks for the operator's thresholds and delays.
//
// Back at thirty seconds. It was briefly five, because the heartbeat used to be the
// only channel a relay command travelled on and half a minute made the app's off
// button feel broken. That fix doubled the TLS exchanges this board makes, from
// fourteen a minute to twenty four, and every one of them is a transmit burst on a
// rail shared with a relay coil.
//
// The command now rides back on the reading POST instead, which happens every five
// seconds regardless, so the button responds just as quickly on fewer requests than
// before. What is left on the heartbeat is thresholds and delays, which change when a
// person changes them and can wait half a minute.
#define HEARTBEAT_INTERVAL_MS 30000
// Reconnection runs on its own cadence rather than riding the heartbeat. Tied to the
// heartbeat, a drop one second after one went out was left unattended for the next 29,
// which is the whole of the API's 30 second freshness window: the dashboard went dark
// at almost exactly the moment the board first tried to recover.
#define RECONNECT_INTERVAL_MS 15000

// Wipes the saved trip, lockout and operator settings once at boot.
//
// A latched trip outlives a reflash, because it lives in NVS rather than in the
// program image. A board that locked out during testing therefore comes back locked
// out, holds the relay open, and refuses to close no matter what the load is doing,
// which reads exactly like a dead relay. Set this to 1, flash once, then set it back
// to 0: leaving it on would throw the operator's thresholds away on every boot and,
// worse, discard a genuine trip across a brownout.
#define CLEAR_SAVED_STATE 0

// Bounds on what a heartbeat may set the alarm thresholds to. The backend is reached
// over TLS with certificate validation disabled, so a party controlling DNS or the
// access point can answer in its place; without a ceiling it could set the load limit
// to 99999, and applyThresholds would write that to NVS where it survives a reboot.
// Sized for a 1 KVA unit with room to spare rather than to model the transformer.

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

  // Adopts thresholds from a heartbeat, but only when they are valid and actually
  // changed, so unchanged heartbeats never wear the flash. Persisting them means an
  // edit made while the board was offline sticks once it reconnects and reboots.
  void applyThresholds(const BackendClient::HeartbeatResult &ack);

  // The same treatment for the reclose delay, kept separate rather than folded into
  // applyThresholds because the two are independent settings: one bad threshold
  // should not stop the delay being adopted, and the threshold check returns early
  // in several places.
  void applyRecloseDelay(const BackendClient::HeartbeatResult &ack);

  // And for the trip wait, which is remembered the same way and for the same reason.
  void applyTripConfirm(const BackendClient::HeartbeatResult &ack);

  // Acts on an operator's relay command, whichever request carried it. Both the
  // reading POST and the heartbeat can hand one over, and the backend guarantees only
  // one of them ever gets it, so this needs no idea which one it came from.
  void applyRelayCommand(BackendClient::RelayCommand command, unsigned long now);

  Lcd lcd;
  BackendClient backend;
  WifiLink net;
  EnergyMeter meter;
  TemperatureProbe probe;
  Relay relay;
  Monitor monitor;
  // Declared after the monitor it reads: members are built in declaration order, and
  // binding to one that does not exist yet is how that bites.
  LiveServer live{monitor};
  Preferences prefs;
  unsigned long lastPost = 0;
  unsigned long lastHeartbeat = 0;
  unsigned long lastReconnect = 0;
  bool tripped = false;
  bool lockedOut = false;
  /// The delay last written to NVS, so an unchanged heartbeat does not rewrite it.
  /// Seeded in begin() from what the monitor ended up holding.
  unsigned long recloseSeconds = 0;
  /// The trip wait last written to NVS, so an unchanged heartbeat does not rewrite it.
  unsigned long tripSeconds = 0;
};
