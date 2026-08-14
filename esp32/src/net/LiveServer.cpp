#include "LiveServer.h"

// Reached this header only by accident before, through a chain the split broke.
#include <WiFi.h>

void LiveServer::begin() {
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

void LiveServer::cors() {
  // The app is not a browser and does not need this, but a laptop checking the board
  // during setup is, and being unable to look is a bad way to debug a demo.
  server.sendHeader("Access-Control-Allow-Origin", "*");
  server.sendHeader("Access-Control-Allow-Headers", "content-type");
}

void LiveServer::appendNumber(String &out, const char *key, float value, int digits) {
  out += "\"";
  out += key;
  out += "\":";
  out += isnan(value) ? String("null") : String(value, digits);
  out += ",";
}

void LiveServer::sendLive() {
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
