#pragma once

#include <Arduino.h>
#include <ArduinoJson.h>
#include <WiFi.h>
#include <WiFiClientSecure.h>
#include <HTTPClient.h>

// Bounds on how long one request may hold the loop. Left at the library defaults, a TLS
// handshake on a link that is up but losing packets waits up to 120 s, and nothing
// else runs meanwhile: no posts, no reconnect, no live server. The dashboard reads that
// as the board being offline for minutes. These still cover a Vercel cold start.
#define HTTP_CONNECT_TIMEOUT_MS 5000
#define HTTP_RESPONSE_TIMEOUT_MS 8000
#define TLS_HANDSHAKE_TIMEOUT_S 8

class BackendClient {
 public:
  BackendClient() = default;

  /// What an operator asked the relay to do, or nothing. The backend hands a command
  /// over exactly once and clears it, so a missed one is not repeated: a queued command
  /// replayed after a reboot would act on an intent minutes stale.
  enum RelayCommand { RELAY_NONE, RELAY_OPEN, RELAY_CLOSE };

  /// What the heartbeat response carried back. NAN on a threshold, or a failed call,
  /// means "no update", so the board keeps what it had.
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

  /// What the backend said when the reading was accepted. The relay command rides here
  /// because this request already happens every few seconds; on the heartbeat it would
  /// have doubled the TLS exchanges, and with them the transmit bursts on the supply.
  struct ReadingResult {
    bool ok = false;
    /// The request got an HTTP answer, whatever the status. False is a transport
    /// failure: no route, no handshake, no response.
    bool reached = false;
    RelayCommand relayCommand = RELAY_NONE;
  };

  ReadingResult postReading(float voltage, float current, float temperature,
                            float power, float pf, float frequency, float energy,
                            bool relayClosed);

 private:
  /// The one TLS client, kept alive between posts. A fresh WiFiClientSecure per call
  /// means a full handshake per call, one to three seconds on this chip, which starves
  /// the loop that also runs the trip timer. Reusing it makes a post a few hundred
  /// milliseconds.
  ///
  /// Still setInsecure: pinning a root CA is the fix, and until then the board
  /// bounds-checks everything a response tells it.
  WiFiClientSecure &shared();

  /// Applies the timeouts above to one request.
  static void bound(HTTPClient &http);

  /// Drops the kept-alive socket after a transport failure, so the next request starts
  /// a clean handshake instead of writing into a connection that is already dead.
  void dropConnection(int code);

  WiFiClientSecure secure;
  bool secureReady = false;

  /// Adds one measurement, reporting whether it had anything to add. A missing sensor
  /// leaves the key out rather than sending null, and `serialized` keeps the precision
  /// the meter actually resolves.
  static bool addMeasurement(JsonDocument &doc, const char *key, float value, int digits);
};
