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
// then drops, which the serial log names as a BEACON_TIMEOUT or NO_AP_FOUND.
#define WIFI_TX_POWER WIFI_POWER_13dBm

// Modem sleep off. With it on the receiver naps between beacons, and phone hotspots in
// particular send theirs irregularly: the board misses enough of them to be dropped, or
// stays associated while nothing reaches it, and either way the dashboard goes dark
// until the next reconnect. Keeping the receiver up costs average current, not peak, so
// it does not bring back the transmit brownout above.
#define WIFI_MODEM_SLEEP false

// Failed joins in a row before the radio is switched off and on again. The stack can
// wedge in a state no begin() gets it out of; at the 15 s reconnect cadence this is
// about a minute of trying the gentle way first.
#define WIFI_RESTART_AFTER_ATTEMPTS 4

class WifiLink {
 public:
  explicit WifiLink(Lcd &lcd) : lcd(lcd) {}

  /// Hands reconnection to the ESP32's own supplicant, which retries in the background
  /// without blocking. connect() then only covers a cold start and a stack that gave up.
  void begin();

  void connect();

  /// For a link that reports connected but carries nothing: drops it and joins again.
  void reconnect();

 private:
  void applyRadioSettings();

  void restartRadio();

  /// Runs on the Wi-Fi event task, so it only records; connect() does the printing.
  static void onDisconnected(arduino_event_id_t event, arduino_event_info_t info);

  /// An attempt that timed out here often finishes in the background. Without this the
  /// count would carry over into the next, unrelated drop and restart the radio early.
  static void onGotIp(arduino_event_id_t event, arduino_event_info_t info);

  static volatile uint8_t lastReason;
  static volatile uint16_t dropCount;
  static volatile bool joined;

  Lcd &lcd;
  uint8_t failedAttempts = 0;
  uint16_t reportedDrops = 0;
};
