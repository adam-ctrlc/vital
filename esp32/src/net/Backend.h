#pragma once

#include <Arduino.h>
#include <WiFiClientSecure.h>

#include "../core/Controller.h"

class Backend {
 public:
  enum class RelayCommand : uint8_t { None, Open, Close };

  struct Reply {
    int code = 0;  // negative = no response
    RelayCommand command = RelayCommand::None;
    uint32_t commandId = 0;
    // heartbeat only; NAN / 0 = not sent
    Protection::Limits limits = {NAN, NAN, NAN};
    uint32_t tripDelaySeconds = 0;
    uint32_t recloseDelaySeconds = 0;

    bool ok() const { return code >= 200 && code < 300; }
    bool answered() const { return code > 0; }
  };

  // ack = highest relay command id applied
  Reply postReading(const Snapshot &snapshot, uint32_t ack);
  Reply postHeartbeat(const Snapshot &snapshot, uint32_t ack, const char *resetReason);

  void disconnect() { tls.stop(); }

 private:
  Reply post(const char *path, const String &body);

  // Kept alive between requests: a TLS handshake costs seconds on this chip.
  WiFiClientSecure tls;
  bool tlsReady = false;
};
