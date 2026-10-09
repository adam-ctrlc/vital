#pragma once

#include <Arduino.h>
#include <DallasTemperature.h>
#include <OneWire.h>
#include <PZEM004Tv30.h>

#include "../Config.h"

// NAN = the sensor gave nothing
struct Reading {
  float voltage = NAN;
  float current = NAN;
  float power = NAN;
  float energy = NAN;
  float frequency = NAN;
  float powerFactor = NAN;
  float temperature = NAN;

  float apparentPower() const { return voltage * current; }
  bool meterOk() const { return !isnan(voltage) && !isnan(current); }
};

class Sensors {
 public:
  Sensors() : pzem(Serial2, PZEM_RX_PIN, PZEM_TX_PIN), wire(DS18B20_PIN), probe(&wire) {}

  void begin();
  Reading read();

 private:
  float readTemperature();

  PZEM004Tv30 pzem;
  OneWire wire;
  DallasTemperature probe;
  float lastTemperature = NAN;
  uint8_t missedTemperatures = 0;
};
