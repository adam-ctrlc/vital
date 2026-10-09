#pragma once

#include <Arduino.h>

#include "../Config.h"

class Relay {
 public:
  void begin() {
    pinMode(RELAY_PIN, OUTPUT);
    set(false);
  }

  // Called every pass, so a write lost to noise or a brownout is corrected.
  void set(bool closed) {
    closed_ = closed;
    const bool high = RELAY_VIA_TRANSISTOR ? closed : !closed;
    digitalWrite(RELAY_PIN, high ? HIGH : LOW);
  }

  bool closed() const { return closed_; }

 private:
  bool closed_ = false;
};
