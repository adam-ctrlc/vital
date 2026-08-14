#pragma once

#include <Arduino.h>
#include <OneWire.h>
#include <DallasTemperature.h>

class TemperatureProbe {
 public:
  explicit TemperatureProbe(uint8_t pin);

  void begin();

  /// Async request/read pattern: returns the value from the previous request, then
  /// kicks off the next conversion without blocking. The -127 (disconnected) and 85
  /// (conversion not complete) guards are dropped and the last good reading is kept,
  /// so a transient bad sample never overwrites a valid temperature.
  ///
  /// Holding the last good value forever is not safe though: an unplugged probe would
  /// report a comfortable temperature indistinguishable from a working sensor, all the
  /// way through to the dashboard. After MAX_STALE_READS consecutive failures the
  /// reading is given up as NAN, which the backend client drops from the payload and
  /// the app renders as "No data".
  float read();

 private:
  /// Three sampling cycles of tolerance for a transient miss before the value is
  /// treated as gone rather than merely late.
  static constexpr uint8_t MAX_STALE_READS = 3;

  uint8_t pin;
  OneWire oneWire;
  DallasTemperature sensors;
  float lastGood;
  uint8_t badReads = 0;
};
