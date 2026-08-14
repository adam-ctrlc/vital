#pragma once

#include <Arduino.h>
#include <WiFi.h>

#include "../hardware/Lcd.h"

// Short on purpose. This spin blocks the control loop, so every second spent here is
// a second in which no sample is taken and the LCD does not refresh. The radio keeps
// trying in the background between calls, so a brief window costs nothing but the
// wait: it only has to cover the case where the AP answers promptly.
#define WIFI_ATTEMPT_TIMEOUT_MS 4000

class WifiLink {
 public:
  explicit WifiLink(Lcd &lcd) : lcd(lcd) {}

  /// Hands reconnection to the ESP32's own supplicant, which retries in the background
  /// without blocking. `connect()` then only has to cover a cold start and the case
  /// where the stack has given up.
  void begin();

  void connect();

 private:
  Lcd &lcd;
};
