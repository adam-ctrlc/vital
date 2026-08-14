#pragma once

#include <Arduino.h>
#include <OneWire.h>
#include <DallasTemperature.h>

#include "../config/Pins.h"

class Ds18b20Test {
 public:
  Ds18b20Test();

  void begin();

  void loop();

 private:
  static void printAddress(DeviceAddress addr);

  OneWire oneWire;
  DallasTemperature sensors;
  unsigned long lastRead = 0;
};
