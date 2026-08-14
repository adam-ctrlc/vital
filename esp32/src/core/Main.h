#pragma once

#include <Arduino.h>
#include <WiFi.h>
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
  Main()
      : lcd(LCD_SDA_PIN, LCD_SCL_PIN, LCD_COLS, LCD_ROWS),
        backend(),
        net(lcd),
        meter(Serial2, PZEM_RX_PIN, PZEM_TX_PIN),
        probe(DS18B20_PIN),
        relay(RELAY_PIN, RELAY_ON, RELAY_OFF),
        monitor(meter, probe, relay, lcd) {}

  void begin() {
    Serial.begin(115200);
    monitor.begin();

    // Adopt the last thresholds seen so a reboot keeps the operator's values instead
    // of falling back to the compiled defaults until the first heartbeat lands.
    prefs.begin("vital", false);
    monitor.setThresholds(prefs.getFloat("loadVa", 900.0f), prefs.getFloat("tripVa", 980.0f),
                          prefs.getFloat("tempC", 40.0f));

    // A trip has to outlive a reboot, because a fault is exactly the condition that
    // browns out the supply. Coming back believing everything is fine would close
    // straight back into it.
    tripped = prefs.getBool("tripped", false);
    lockedOut = prefs.getBool("locked", false);
    if (tripped) {
      Serial.println(lockedOut ? "restored a lockout, load stays open until reset"
                               : "restored a trip from before the reboot, load stays open");
      monitor.restoreTrip(millis(), lockedOut);
    }

    net.begin();
    net.connect();

    // After the link, since it prints the address it is reachable on and there is no
    // address before then.
    live.begin();
  }

  void loop() {
    unsigned long now = millis();

    monitor.loop(now);

    // Written only on the edge, so the flash sees one write per trip and one per
    // reclose rather than one per sample.
    if (monitor.isTripped() != tripped) {
      tripped = monitor.isTripped();
      prefs.putBool("tripped", tripped);
    }

    // Kept separately from the trip. A trip is a state the board can leave on its own;
    // a lockout is one it cannot, so losing it to a reboot would quietly re-energise
    // the very fault it was holding open.
    if (monitor.isLockedOut() != lockedOut) {
      lockedOut = monitor.isLockedOut();
      prefs.putBool("locked", lockedOut);
      if (lockedOut) Serial.println("out of reclose attempts, load stays open until reset");
    }

    if (WiFi.status() != WL_CONNECTED && now - lastReconnect >= RECONNECT_INTERVAL_MS) {
      lastReconnect = now;
      net.connect();
    }

    bool online = WiFi.status() == WL_CONNECTED;

    // Crossing the alarm level is posted the instant it is seen, on its own path and
    // off the schedule. On the interval alone the backend heard about an overload up to
    // POST_INTERVAL_MS late, and every one of those seconds is a second before anyone
    // is told. There is no timer here at all: it goes out in the same pass that saw it.
    if (monitor.takeAlarmEdge() && online) post();

    // The record of the run, unchanged and deliberately not reset by the line above, so
    // rows stay evenly spaced whether or not an alarm interrupted them.
    //
    // This interval is what decides how often a row is stored: in hardware mode the API
    // keeps every reading it is given, so the board's cadence is the database's. It is
    // not a display rate, and lowering it is paid for in rows and invocations rather
    // than in how quickly an overload is noticed, which no longer waits for it at all.
    if (now - lastPost >= POST_INTERVAL_MS) {
      lastPost = now;
      if (online) post();
    }

    // Served every pass and never waited on, so a caller cannot hold up the sampling
    // or the trip timer that share this loop.
    live.loop();

    const unsigned long heartbeatEvery =
        monitor.isLockedOut() ? LOCKED_HEARTBEAT_INTERVAL_MS : HEARTBEAT_INTERVAL_MS;

    if (now - lastHeartbeat >= heartbeatEvery) {
      lastHeartbeat = now;
      if (online) {
        BackendClient::HeartbeatResult ack = backend.postHeartbeat(monitor.isLockedOut());
        applyThresholds(ack);

        // An operator has been to look and says to close it. The board cannot reach
        // this conclusion itself, which is the whole reason it locked out.
        if (ack.ok && ack.resetRelay) monitor.resetLockout(now);
      }
    }
  }

 private:
  void post() {
    Monitor::Snapshot s = monitor.snapshot();
    backend.postReading(s.voltage, s.current, s.temperature, s.power, s.powerFactor,
                        s.frequency, s.energy, monitor.relayClosed());
  }

  // Adopts thresholds from a heartbeat, but only when they are valid and actually
  // changed, so unchanged heartbeats never wear the flash. Persisting them means an
  // edit made while the board was offline sticks once it reconnects and reboots.
  void applyThresholds(const BackendClient::HeartbeatResult &ack) {
    if (!ack.ok) return;

    float va = ack.loadThresholdVa;
    float trip = ack.tripThresholdVa;
    float temp = ack.tempThresholdC;
    if (isnan(va) || isnan(trip) || isnan(temp)) return;
    if (va < MIN_LOAD_THRESHOLD_VA || va > MAX_LOAD_THRESHOLD_VA) {
      Serial.print("rejected out of range load threshold: ");
      Serial.println(va, 0);
      return;
    }
    if (trip < MIN_LOAD_THRESHOLD_VA || trip > MAX_LOAD_THRESHOLD_VA) {
      Serial.print("rejected out of range trip threshold: ");
      Serial.println(trip, 0);
      return;
    }
    // Checked on the board as well as in the API, because this is the pair that
    // decides when the load is cut and the response arrives over a TLS connection
    // whose certificate is not validated. A trip at or below the alarm would open the
    // relay during load the operator meant to merely be warned about.
    if (trip <= va) {
      Serial.print("rejected trip threshold not above the alarm: ");
      Serial.print(trip, 0);
      Serial.print(" <= ");
      Serial.println(va, 0);
      return;
    }
    if (temp < MIN_TEMP_THRESHOLD_C || temp > MAX_TEMP_THRESHOLD_C) {
      Serial.print("rejected out of range temp threshold: ");
      Serial.println(temp, 0);
      return;
    }

    if (fabs(va - monitor.loadThreshold()) < 0.05f &&
        fabs(trip - monitor.tripThreshold()) < 0.05f &&
        fabs(temp - monitor.tempThreshold()) < 0.05f) {
      return;
    }

    monitor.setThresholds(va, trip, temp);
    prefs.putFloat("loadVa", va);
    prefs.putFloat("tripVa", trip);
    prefs.putFloat("tempC", temp);

    Serial.print("thresholds updated -> ALARM:");
    Serial.print(va, 0);
    Serial.print(" TRIP:");
    Serial.print(trip, 0);
    Serial.print(" TEMP:");
    Serial.println(temp, 0);
  }

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
