#include "Sensors.h"

static constexpr uint8_t MAX_MISSED_TEMPERATURES = 3;

void Sensors::begin() {
  Serial2.begin(9600, SERIAL_8N1, PZEM_RX_PIN, PZEM_TX_PIN);
  pinMode(DS18B20_PIN, INPUT_PULLUP);
  probe.begin();
  probe.setWaitForConversion(false);
  probe.requestTemperatures();
}

Reading Sensors::read() {
  Reading r;

  // The library caches even a failed read, so after a NAN voltage the rest would read 0.
  r.voltage = pzem.voltage();
  if (!isnan(r.voltage)) {
    r.current = pzem.current();
    r.power = pzem.power();
    r.energy = pzem.energy();
    r.frequency = pzem.frequency();
    r.powerFactor = pzem.pf();
  }

  r.temperature = readTemperature();
  return r;
}

float Sensors::readTemperature() {
  const float t = probe.getTempCByIndex(0);
  probe.requestTemperatures();

  // -127 = no probe, 85 = conversion never ran
  if (t != DEVICE_DISCONNECTED_C && t != 85.0f) {
    lastTemperature = t;
    missedTemperatures = 0;
  } else if (++missedTemperatures > MAX_MISSED_TEMPERATURES) {
    lastTemperature = NAN;
  }
  return lastTemperature;
}
