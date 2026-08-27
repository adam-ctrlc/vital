#pragma once

#include <Arduino.h>
#include <WiFi.h>

#include "../hardware/Lcd.h"

// Short on purpose: this spin blocks the control loop, so every second here is a second
// with no sample taken. The radio keeps trying in the background between calls, so this
// only has to cover an AP that answers promptly.
#define WIFI_ATTEMPT_TIMEOUT_MS 4000

// Transmit power, below the 19.5 dBm default.
//
// Transmit is the current peak that matters here: the radio pulls close to 300 mA for
// the length of a frame, off the same 5V rail as the relay coil and the LCD backlight.
// Every reset seen so far has been a POWERON_RESET during association, which is the rail
// collapsing rather than the firmware crashing.
//
// 13 dBm is far more than a hotspot in the same room needs. Raise it if the board ever
// has to reach across a building; too little shows up as a link that associates and
// then drops.
#define WIFI_TX_POWER WIFI_POWER_13dBm

class WifiLink {
 public:
  explicit WifiLink(Lcd &lcd) : lcd(lcd) {}

  /// Hands reconnection to the ESP32's own supplicant, which retries in the background
  /// without blocking. connect() then only covers a cold start and a stack that gave up.
  void begin();

  void connect();

 private:
  Lcd &lcd;
};
