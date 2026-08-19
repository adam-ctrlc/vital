#pragma once

#include <Arduino.h>
#include <WiFi.h>

#include "../hardware/Lcd.h"

// Short on purpose. This spin blocks the control loop, so every second spent here is
// a second in which no sample is taken and the LCD does not refresh. The radio keeps
// trying in the background between calls, so a brief window costs nothing but the
// wait: it only has to cover the case where the AP answers promptly.
#define WIFI_ATTEMPT_TIMEOUT_MS 4000

// Transmit power, below the 19.5 dBm default.
//
// Transmit is the current peak that matters on this board: the radio pulls close to
// 300 mA for the length of a frame, and the 5V rail it pulls from is the same one
// feeding the relay coil and the LCD backlight. Every reset seen so far has been a
// POWERON_RESET during association, which is the rail collapsing rather than the
// firmware crashing.
//
// 13 dBm is twenty milliwatts, far more than a hotspot in the same room needs, and it
// takes a useful bite out of that peak. Raise it if the board ever has to reach across
// a building; the symptom of too little would be a link that associates and drops.
#define WIFI_TX_POWER WIFI_POWER_13dBm

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
