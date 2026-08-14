#include "TemperatureProbe.h"

TemperatureProbe::TemperatureProbe(uint8_t pin)
    : pin(pin), oneWire(pin), sensors(&oneWire), lastGood(NAN) {}

void TemperatureProbe::begin() {
  pinMode(pin, INPUT_PULLUP);
  sensors.begin();
  sensors.setWaitForConversion(false);
  sensors.requestTemperatures();
}

float TemperatureProbe::read() {
  float t = sensors.getTempCByIndex(0);
  sensors.requestTemperatures();

  if (t != DEVICE_DISCONNECTED_C && t != 85.0f) {
    lastGood = t;
    badReads = 0;
  } else if (badReads < MAX_STALE_READS) {
    badReads++;
  } else {
    lastGood = NAN;
  }

  return lastGood;
}
