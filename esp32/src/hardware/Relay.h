#pragma once

#include <Arduino.h>

class Relay {
 public:
  Relay(uint8_t pin, uint8_t onLevel, uint8_t offLevel);

  /// Comes up open, not closed.
  ///
  /// The load stays disconnected until something has actually been measured and judged
  /// safe, which Monitor does on its first sample a second later. Closing here would
  /// energize on faith, and on a board restored into a trip it would briefly re-close
  /// into the fault before the state machine reopened it.
  void begin();

  void set(bool closed);

  bool isClosed() const { return closed_; }

  /// Which pin it drives, so a caller can say so in a log without being handed the
  /// pin map. Diagnostics that name the wrong terminal are worse than none.
  uint8_t number() const { return pin; }

 private:
  uint8_t pin;
  uint8_t onLevel;
  uint8_t offLevel;
  bool closed_;
};
