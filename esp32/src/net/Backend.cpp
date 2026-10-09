#include "Backend.h"

#include <ArduinoJson.h>
#include <HTTPClient.h>
#include <WiFi.h>

#include "../../secrets.h"

static bool put(JsonDocument &doc, const char *key, float value, int digits) {
  if (isnan(value)) return false;
  doc[key] = serialized(String(value, digits));
  return true;
}

Backend::Reply Backend::postReading(const Snapshot &s, uint32_t ack) {
  JsonDocument doc;
  bool any = false;
  any |= put(doc, "voltageV", s.reading.voltage, 1);
  any |= put(doc, "currentA", s.reading.current, 3);
  any |= put(doc, "temperatureC", s.reading.temperature, 2);
  any |= put(doc, "powerW", s.reading.power, 1);
  any |= put(doc, "powerFactor", s.reading.powerFactor, 2);
  any |= put(doc, "frequencyHz", s.reading.frequency, 1);
  any |= put(doc, "energyKwh", s.reading.energy, 3);
  if (!any) return Reply{};

  doc["relayClosed"] = s.relayClosed;
  doc["relayCommandAck"] = ack;
  String body;
  serializeJson(doc, body);
  return post("/api/v1/readings", body);
}

Backend::Reply Backend::postHeartbeat(const Snapshot &s, uint32_t ack, const char *resetReason) {
  JsonDocument doc;
  doc["deviceId"] = DEVICE_ID;
  doc["firmware"] = FIRMWARE_VERSION;
  doc["ssid"] = WiFi.SSID();
  doc["ipAddress"] = WiFi.localIP().toString();
  doc["signalDbm"] = WiFi.RSSI();
  doc["uptimeSeconds"] = millis() / 1000;
  doc["relayLockedOut"] = s.lockedOut;
  doc["resetReason"] = resetReason;
  doc["relayCommandAck"] = ack;
  String body;
  serializeJson(doc, body);
  return post("/api/v1/device/heartbeat", body);
}

Backend::Reply Backend::post(const char *path, const String &body) {
  if (!tlsReady) {
    tls.setInsecure();
    tls.setHandshakeTimeout(TLS_HANDSHAKE_TIMEOUT_S);
    tlsReady = true;
  }

  HTTPClient http;
  http.begin(tls, String(BACKEND_URL) + path);
  http.setReuse(true);
  http.setConnectTimeout(HTTP_CONNECT_TIMEOUT_MS);
  http.setTimeout(HTTP_RESPONSE_TIMEOUT_MS);
  http.addHeader("Content-Type", "application/json");
  http.addHeader("x-device-key", DEVICE_KEY);

  Reply reply;
  reply.code = http.POST(body);
  Serial.printf("POST %s -> %d\n", path, reply.code);

  if (reply.ok()) {
    JsonDocument doc;
    if (!deserializeJson(doc, http.getString())) {
      const char *command = doc["relayCommand"] | "";
      if (!strcmp(command, "open")) reply.command = RelayCommand::Open;
      if (!strcmp(command, "close")) reply.command = RelayCommand::Close;
      reply.commandId = doc["relayCommandId"] | 0UL;
      reply.limits = {doc["loadThresholdVa"] | NAN, doc["tripThresholdVa"] | NAN, doc["tempThresholdC"] | NAN};
      reply.tripDelaySeconds = doc["tripConfirmSeconds"] | 0UL;
      reply.recloseDelaySeconds = doc["recloseDelaySeconds"] | 0UL;
    }
  } else if (reply.answered()) {
    Serial.println(http.getString());
  } else {
    Serial.println(http.errorToString(reply.code));
  }
  http.end();

  if (!reply.answered()) tls.stop();
  return reply;
}
