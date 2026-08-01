#pragma once

#include <Arduino.h>
#include <WiFi.h>
#include <Preferences.h>

#include "../config/Pins.h"
#include "Monitor.h"
#include "../hardware/Lcd.h"
#include "../hardware/EnergyMeter.h"
#include "../hardware/TemperatureProbe.h"
#include "../hardware/Relay.h"
#include "../net/BackendClient.h"
#include "../net/WifiLink.h"

#define POST_INTERVAL_MS 10000
#define HEARTBEAT_INTERVAL_MS 30000
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
    if (tripped) {
      Serial.println("restored a trip from before the reboot, load stays open");
      monitor.restoreTrip(millis());
    }

    net.begin();
    net.connect();
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

    if (WiFi.status() != WL_CONNECTED && now - lastReconnect >= RECONNECT_INTERVAL_MS) {
      lastReconnect = now;
      net.connect();
    }

    bool online = WiFi.status() == WL_CONNECTED;

    if (now - lastPost >= POST_INTERVAL_MS) {
      lastPost = now;
      if (online) {
        Monitor::Snapshot s = monitor.snapshot();
        backend.postReading(s.voltage, s.current, s.temperature, s.power,
                            s.powerFactor, s.frequency, s.energy);
      }
    }

    if (now - lastHeartbeat >= HEARTBEAT_INTERVAL_MS) {
      lastHeartbeat = now;
      if (online) applyThresholds(backend.postHeartbeat());
    }
  }

 private:
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
  Preferences prefs;
  unsigned long lastPost = 0;
  unsigned long lastHeartbeat = 0;
  unsigned long lastReconnect = 0;
  bool tripped = false;
};
