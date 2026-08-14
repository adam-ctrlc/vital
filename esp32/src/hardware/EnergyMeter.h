#pragma once

#include <Arduino.h>
#include <HardwareSerial.h>
#include <PZEM004Tv30.h>

class EnergyMeter {
 public:
  struct Reading {
    float voltage;
    float current;
    float power;
    float energy;
    float frequency;
    float powerFactor;
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
