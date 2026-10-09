#include "LiveServer.h"

#include <ArduinoJson.h>

static void put(JsonDocument &doc, const char *key, float value, int digits) {
  if (isnan(value)) {
    doc[key] = nullptr;
  } else {
    doc[key] = serialized(String(value, digits));
  }
}

void LiveServer::begin() {
  DefaultHeaders::Instance().addHeader("Access-Control-Allow-Origin", "*");
  DefaultHeaders::Instance().addHeader("Access-Control-Allow-Headers", "content-type");

  server.on("/live", HTTP_GET, [this](AsyncWebServerRequest *request) {
    const Snapshot s = controller.snapshot();
    JsonDocument doc;
    put(doc, "voltageV", s.reading.voltage, 1);
    put(doc, "currentA", s.reading.current, 2);
    put(doc, "temperatureC", s.reading.temperature, 1);
    put(doc, "powerW", s.reading.power, 1);
    put(doc, "powerFactor", s.reading.powerFactor, 2);
    put(doc, "frequencyHz", s.reading.frequency, 1);
    put(doc, "energyKwh", s.reading.energy, 3);
    doc["status"] = Protection::label(s.state);
    doc["relay"] = s.relayClosed ? "CLOSED" : "OPEN";
    doc["uptimeSeconds"] = millis() / 1000;

    String body;
    serializeJson(doc, body);
    request->send(200, "application/json", body);
  });

  server.onNotFound([](AsyncWebServerRequest *request) {
    request->send(request->method() == HTTP_OPTIONS ? 204 : 404);
  });

  server.begin();
}
