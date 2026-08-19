#pragma once

#include <Arduino.h>
#include <ArduinoJson.h>
#include <WiFi.h>
#include <WiFiClientSecure.h>
#include <HTTPClient.h>

class BackendClient {
 public:
  BackendClient() = default;

  /// What an operator asked the relay to do, or nothing.
  ///
  /// The backend hands a command over exactly once and clears it in the same statement,
  /// so a command missed here is not repeated. That is deliberate: a queued command
  /// replayed after a reboot would act on an intent minutes stale.
  enum RelayCommand { RELAY_NONE, RELAY_OPEN, RELAY_CLOSE };

  /// What the heartbeat response carried back.
  ///
  /// NAN on a threshold (or a failed call) means "no update", so the board keeps what
  /// it had rather than falling back to a default.
  struct HeartbeatResult {
    bool ok = false;
    float loadThresholdVa = NAN;
    float tripThresholdVa = NAN;
    float tempThresholdC = NAN;
    /// What an operator asked for, if anything, since the last heartbeat.
    RelayCommand relayCommand = RELAY_NONE;
    /// The operator's reclose wait. Zero means the response did not carry one.
    unsigned long recloseDelaySeconds = 0;
    /// The operator's trip wait. Zero means the response did not carry one.
    unsigned long tripConfirmSeconds = 0;
  };

  HeartbeatResult postHeartbeat(bool lockedOut);

  /// What the backend said when the reading was accepted.
  ///
  /// The relay command rides on this response because the board makes this request
  /// every few seconds anyway. Carrying it on the heartbeat instead meant running the
  /// heartbeat at the same rate purely for this field, which doubled the number of TLS
  /// exchanges and with them the transmit bursts this board's supply has to survive.
  struct ReadingResult {
    bool ok = false;
    RelayCommand relayCommand = RELAY_NONE;
  };

  ReadingResult postReading(float voltage, float current, float temperature,
                            float power, float pf, float frequency, float energy,
                            bool relayClosed);

 private:
  /// The one TLS client, kept alive between posts.
  ///
  /// A fresh `WiFiClientSecure` per call meant a full handshake per call, which on this
  /// chip is one to three seconds: longer than the interval it was being asked to keep,
  /// and long enough to starve the loop that also runs the trip timer. Holding the
  /// session open makes a post a few hundred milliseconds instead.
  ///
  /// Still `setInsecure`, and still deliberately: pinning a root CA is the fix for that,
  /// and the board bound-checks anything a response tells it in the meantime.
  WiFiClientSecure &shared();

  WiFiClientSecure secure;
  bool secureReady = false;

  /// Adds one measurement, reporting whether it had anything to add.
  ///
  /// A missing sensor leaves the key out entirely rather than sending null, keeping
  /// the payload to the subset the API documents. `serialized` preserves the per
  /// field precision the meter actually resolves, so energy still reads 12.500 rather
  /// than a float's full expansion.
  static bool addMeasurement(JsonDocument &doc, const char *key, float value, int digits);
};
