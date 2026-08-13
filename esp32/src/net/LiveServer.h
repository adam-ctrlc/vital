#pragma once

#include <WebServer.h>

#include "../core/Monitor.h"

/// Serves the current reading to anything on the same network.
///
/// The point is latency. Going through the backend means a TLS post, a database write
/// and a poll on the other side, so the app sees a number seconds after the board took
/// it. On a shared network, and a phone hotspot is one, the app can ask the board
/// directly and have it in milliseconds.
///
/// This is a live view, not a record. Nothing here is stored, and the backend still
/// gets its own posts on their own schedule: the two paths answer different questions
/// and neither replaces the other. Alerts in particular stay with the backend, because
/// they have to reach phones that are not on this network.
///
/// Plain HTTP on purpose. A device on a local address cannot hold a certificate anyone
/// would trust, and the alternative, a self-signed one, trains people to click through
/// warnings. What it exposes is what the app already shows and what the backend already
/// has, to callers who are already inside the network.
class LiveServer {
 public:
  explicit LiveServer(Monitor &monitor) : monitor(monitor), server(PORT) {}

  void begin() {
    server.on("/live", HTTP_GET, [this]() { sendLive(); });

    // A browser hitting the board from a laptop on the same network sends this before
    // the request it actually wants, and a missing answer reads as the board being down.
    server.onNotFound([this]() {
      if (server.method() == HTTP_OPTIONS) {
        cors();
        server.send(204);
        return;
      }

      cors();
      server.send(404, "application/json", "{\"error\":\"not found\"}");
    });

    server.begin();
    Serial.print("live server on http://");
    Serial.print(WiFi.localIP());
    Serial.print(":");
    Serial.print(PORT);
    Serial.println("/live");
  }

  /// Non-blocking, and called every pass. The loop it sits in also runs the trip timer,
  /// so this must never wait on a client.
  void loop() { server.handleClient(); }

 private:
  static constexpr uint16_t PORT = 80;

  void cors() {
    // The app is not a browser and does not need this, but a laptop checking the board
    // during setup is, and being unable to look is a bad way to debug a demo.
    server.sendHeader("Access-Control-Allow-Origin", "*");
    server.sendHeader("Access-Control-Allow-Headers", "content-type");
  }

  /// Emits a number, or `null` when the sensor did not give one.
  ///
  /// Never a bare `nan`: that is not valid JSON and would throw in the parser at exactly
  /// the moment a sensor had failed, which is when the reading matters most.
  static void appendNumber(String &out, const char *key, float value, int digits) {
    out += "\"";
    out += key;
    out += "\":";
    out += isnan(value) ? String("null") : String(value, digits);
    out += ",";
  }

  void sendLive() {
    Monitor::Snapshot s = monitor.snapshot();

    String body;
    body.reserve(320);
    body += "{";
    appendNumber(body, "voltageV", s.voltage, 1);
    appendNumber(body, "currentA", s.current, 2);
    appendNumber(body, "temperatureC", s.temperature, 1);
    appendNumber(body, "powerW", s.power, 1);
    appendNumber(body, "powerFactor", s.powerFactor, 2);
    appendNumber(body, "frequencyHz", s.frequency, 1);
    appendNumber(body, "energyKwh", s.energy, 3);
    body += "\"status\":\"";
    body += monitor.statusLabel();
    body += "\",\"relay\":\"";
    body += monitor.relayClosed() ? "CLOSED" : "OPEN";
    body += "\",\"uptimeSeconds\":";
    body += String(millis() / 1000);
    body += "}";

    cors();
    server.send(200, "application/json", body);
  }

  Monitor &monitor;
  WebServer server;
};
