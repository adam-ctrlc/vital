#pragma once

#include <Arduino.h>
#include <ArduinoJson.h>
#include <WiFi.h>
#include <WiFiClientSecure.h>
#include <HTTPClient.h>

#include "../../secrets.h"
#include "../config/Device.h"

class BackendClient {
 public:
  BackendClient() = default;

  // The heartbeat response carries the operator's alarm thresholds. NAN on either
  // field (or a failed call) means "no update", so the board keeps what it had.
  struct HeartbeatResult {
    bool ok = false;
    float loadThresholdVa = NAN;
    float tripThresholdVa = NAN;
    float tempThresholdC = NAN;
  };

  HeartbeatResult postHeartbeat() {
    HeartbeatResult result;
    if (WiFi.status() != WL_CONNECTED) return result;

    JsonDocument doc;
    doc["deviceId"] = DEVICE_ID;
    doc["firmware"] = FIRMWARE_VERSION;
    // The serializer escapes these. Concatenated by hand they were a latent break:
    // an SSID holding a quote or a backslash produced malformed JSON and a 400 that
    // would have read as the board being broken.
    doc["ssid"] = WiFi.SSID();
    doc["ipAddress"] = WiFi.localIP().toString();
    doc["signalDbm"] = (int)WiFi.RSSI();
    doc["uptimeSeconds"] = (unsigned long)(millis() / 1000);

    String body;
    serializeJson(doc, body);

    WiFiClientSecure client;
    client.setInsecure();

    HTTPClient http;
    http.begin(client, String(BACKEND_URL) + "/api/v1/device/heartbeat");
    http.addHeader("Content-Type", "application/json");
    http.addHeader("x-device-key", DEVICE_KEY);

    int code = http.POST(body);
    Serial.print("POST /heartbeat -> ");
    Serial.println(code);
    if (code >= 200 && code < 300) {
      result.ok = true;

      // A body that will not parse leaves both thresholds NAN, which applyThresholds
      // already reads as "no update".
      JsonDocument ack;
      if (!deserializeJson(ack, http.getString())) {
        result.loadThresholdVa = ack["loadThresholdVa"] | NAN;
        result.tripThresholdVa = ack["tripThresholdVa"] | NAN;
        result.tempThresholdC = ack["tempThresholdC"] | NAN;
      }
    }
    http.end();

    return result;
  }

  bool postReading(float voltage, float current, float temperature,
                   float power, float pf, float frequency, float energy) {
    if (WiFi.status() != WL_CONNECTED) return false;

    JsonDocument doc;
    bool any = false;
    any |= addMeasurement(doc, "voltageV", voltage, 1);
    any |= addMeasurement(doc, "currentA", current, 3);
    any |= addMeasurement(doc, "temperatureC", temperature, 2);
    any |= addMeasurement(doc, "powerW", power, 1);
    any |= addMeasurement(doc, "powerFactor", pf, 2);
    any |= addMeasurement(doc, "frequencyHz", frequency, 1);
    any |= addMeasurement(doc, "energyKwh", energy, 3);

    if (!any) {
      Serial.println("no readings to send, skipping post.");
      return false;
    }

    String body;
    serializeJson(doc, body);

    WiFiClientSecure client;
    client.setInsecure();

    HTTPClient http;
    http.begin(client, String(BACKEND_URL) + "/api/v1/readings");
    http.addHeader("Content-Type", "application/json");
    http.addHeader("x-device-key", DEVICE_KEY);

    int code = http.POST(body);
    Serial.print("POST /readings -> ");
    Serial.println(code);
    if (code > 0) {
      Serial.println(http.getString());
    } else {
      Serial.println(http.errorToString(code));
    }
    http.end();

    return code >= 200 && code < 300;
  }

 private:
  /// Adds one measurement, reporting whether it had anything to add.
  ///
  /// A missing sensor leaves the key out entirely rather than sending null, keeping
  /// the payload to the subset the API documents. `serialized` preserves the per
  /// field precision the meter actually resolves, so energy still reads 12.500 rather
  /// than a float's full expansion.
  static bool addMeasurement(JsonDocument &doc, const char *key, float value, int digits) {
    if (isnan(value)) return false;

    doc[key] = serialized(String(value, digits));
    return true;
  }
};
