#pragma once

#include <Arduino.h>

class Relay {
 public:
  Relay(uint8_t pin, uint8_t onLevel, uint8_t offLevel);

  /// Comes up open. The load stays disconnected until Monitor has measured something
  /// and judged it safe, a second later. Closing here would energize on faith, and on a
  /// board restored into a trip it would re-close into the fault first.
  void begin();

  void set(bool closed);

  bool isClosed() const { return closed_; }

  /// Which pin it drives, so a caller can name it in a log without holding the pin map.
  uint8_t number() const { return pin; }

 private:
  uint8_t pin;
  uint8_t onLevel;
  uint8_t offLevel;
  bool closed_;
};
