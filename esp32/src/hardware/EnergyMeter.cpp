#include "EnergyMeter.h"

EnergyMeter::EnergyMeter(HardwareSerial &serial, uint8_t rx, uint8_t tx)
    : serial(serial), rxPin(rx), txPin(tx), pzem(serial, rx, tx) {}

void EnergyMeter::begin() {
  serial.begin(9600, SERIAL_8N1, rxPin, txPin);
}

EnergyMeter::Reading EnergyMeter::read() {
  Reading r;
  r.voltage = pzem.voltage();
  r.current = pzem.current();
  r.power = pzem.power();
  r.energy = pzem.energy();
  r.frequency = pzem.frequency();
  r.powerFactor = pzem.pf();
  return r;
}
