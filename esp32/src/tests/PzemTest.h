#pragma once

#include <Arduino.h>

#include "../config/Pins.h"
#include "../hardware/EnergyMeter.h"
#include "../hardware/Relay.h"

#define READ_INTERVAL_MS 2000
#define TOGGLE_INTERVAL_MS 10000

class PzemTest {
 public:
  PzemTest();

  void begin();

  void loop();

 private:
  EnergyMeter meter;
  Relay relay;
  unsigned long lastRead = 0;
  unsigned long lastToggle = 0;
};
