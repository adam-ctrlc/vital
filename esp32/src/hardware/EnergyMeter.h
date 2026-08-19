#pragma once

#include <Arduino.h>
#include <HardwareSerial.h>
#include <PZEM004Tv30.h>

class EnergyMeter {
 public:
  /// Every field defaults to NAN so an abandoned read reports absence rather than
  /// whatever was on the stack. `read()` returns early when the meter does not
  /// answer, and without these the caller would be handed six garbage floats.
  struct Reading {
    float voltage = NAN;
    float current = NAN;
    float power = NAN;
    float energy = NAN;
    float frequency = NAN;
    float powerFactor = NAN;
  };

  EnergyMeter(HardwareSerial &serial, uint8_t rx, uint8_t tx);

  void begin();

  Reading read();

 private:
  HardwareSerial &serial;
  uint8_t rxPin;
  uint8_t txPin;
  PZEM004Tv30 pzem;
};
