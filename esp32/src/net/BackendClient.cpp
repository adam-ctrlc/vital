#include "BackendClient.h"

// The URL, the device key and the identity stop here rather than reaching everything
// that includes the header.
#include "../../secrets.h"
#include "../config/Device.h"

BackendClient::HeartbeatResult BackendClient::postHeartbeat(bool lockedOut) {
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
  // Reported so an operator can see the load is off on purpose rather than the board
  // having died, which look identical from the outside.
  doc["relayLockedOut"] = lockedOut;

  String body;
  serializeJson(doc, body);

  HTTPClient http;
  http.begin(shared(), String(BACKEND_URL) + "/api/v1/device/heartbeat");
  http.setReuse(true);
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

      // Copied into the enum here rather than carried out as a pointer: the string
      // belongs to the JsonDocument, which dies at the end of this scope. Anything
      // other than the two known words is left as NONE, so a field the backend one
      // day adds a third value to cannot be read as a command to move the contacts.
      const char *command = ack["relayCommand"] | "";
      if (strcmp(command, "open") == 0) {
        result.relayCommand = RELAY_OPEN;
      } else if (strcmp(command, "close") == 0) {
        result.relayCommand = RELAY_CLOSE;
      }

      result.recloseDelaySeconds = ack["recloseDelaySeconds"] | 0UL;
      result.tripConfirmSeconds = ack["tripConfirmSeconds"] | 0UL;
    }
  }
  http.end();

  return result;
}

bool BackendClient::postReading(float voltage, float current, float temperature,
                                float power, float pf, float frequency, float energy,
                                bool relayClosed) {
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

  // Added after the emptiness check on purpose. A contact position is not a
  // measurement, so a payload carrying only this is still nothing to record and the
  // backend would rightly refuse it.
  doc["relayClosed"] = relayClosed;

  String body;
  serializeJson(doc, body);

  HTTPClient http;
  http.begin(shared(), String(BACKEND_URL) + "/api/v1/readings");
  // Asks the server to hold the socket open, which is what lets the next post skip
  // the handshake. Without it the connection is closed under us and reuse is moot.
  http.setReuse(true);
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

WiFiClientSecure &BackendClient::shared() {
  if (!secureReady) {
    secure.setInsecure();
    secureReady = true;
  }

  return secure;
}

bool BackendClient::addMeasurement(JsonDocument &doc, const char *key, float value,
                                   int digits) {
  if (isnan(value)) return false;

  doc[key] = serialized(String(value, digits));
  return true;
}
