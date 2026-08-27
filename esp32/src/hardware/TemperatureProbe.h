#pragma once

#include <Arduino.h>
#include <OneWire.h>
#include <DallasTemperature.h>

class TemperatureProbe {
 public:
  explicit TemperatureProbe(uint8_t pin);

  void begin();

  /// Returns the previous request's value, then starts the next conversion without
  /// blocking. The -127 (disconnected) and 85 (conversion not complete) sentinels are
  /// dropped in favor of the last good reading, so a transient miss changes nothing.
  ///
  /// Not held forever, though: an unplugged probe would report a comfortable temperature
  /// all the way to the dashboard. After MAX_STALE_READS failures it gives up and
  /// returns NAN, which the app renders as "No data".
  float read();

 private:
  /// Sampling cycles of tolerance before the value is treated as gone rather than late.
  static constexpr uint8_t MAX_STALE_READS = 3;

  uint8_t pin;
  OneWire oneWire;
  DallasTemperature sensors;
  float lastGood;
  uint8_t badReads = 0;
};
