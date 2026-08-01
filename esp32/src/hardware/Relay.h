#pragma once

#include <Arduino.h>

class Relay {
 public:
  Relay(uint8_t pin, uint8_t onLevel, uint8_t offLevel)
      // Open until begin() runs. Before that the pin is still an input held high by
      // its pull up, which for an active low module is the de-energized state, so
      // reporting closed here would have been a lie the first sample acted on.
      : pin(pin), onLevel(onLevel), offLevel(offLevel), closed_(false) {}

  /// Comes up open, not closed.
  ///
  /// The load stays disconnected until something has actually been measured and judged
  /// safe, which Monitor does on its first sample a second later. Closing here would
  /// energize on faith, and on a board restored into a trip it would briefly re-close
  /// into the fault before the state machine reopened it.
  void begin() {
    pinMode(pin, OUTPUT);
    set(false);
  }

  void set(bool closed) {
    closed_ = closed;
    digitalWrite(pin, closed ? onLevel : offLevel);
  }

  bool isClosed() const { return closed_; }

 private:
  uint8_t pin;
  uint8_t onLevel;
  uint8_t offLevel;
  bool closed_;
};
