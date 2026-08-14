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
#define HEARTBEAT_INTERVAL_MS 30000
/// How often to ask while locked out.
///
/// The heartbeat is the only thing that ever asks the backend a question, so it is also
/// how a reset reaches the board. Half a minute is fine for reporting link state and far
/// too long to stand next to a transformer waiting for the load to come back.
#define LOCKED_HEARTBEAT_INTERVAL_MS 5000
// Reconnection runs on its own cadence rather than riding the heartbeat. Tied to the
// heartbeat, a drop one second after one went out was left unattended for the next 29,
// which is the whole of the API's 30 second freshness window: the dashboard went dark
// at almost exactly the moment the board first tried to recover.
#define RECONNECT_INTERVAL_MS 15000

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
  void post();

  // Adopts thresholds from a heartbeat, but only when they are valid and actually
  // changed, so unchanged heartbeats never wear the flash. Persisting them means an
  // edit made while the board was offline sticks once it reconnects and reboots.
  void applyThresholds(const BackendClient::HeartbeatResult &ack);

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
};
