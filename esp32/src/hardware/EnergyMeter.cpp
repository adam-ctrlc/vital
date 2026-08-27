#include "EnergyMeter.h"

EnergyMeter::EnergyMeter(HardwareSerial &serial, uint8_t rx, uint8_t tx)
    : serial(serial), rxPin(rx), txPin(tx), pzem(serial, rx, tx) {}

void EnergyMeter::begin() {
  serial.begin(9600, SERIAL_8N1, rxPin, txPin);
}

EnergyMeter::Reading EnergyMeter::read() {
  Reading r;

  // Voltage first, and it decides whether the rest is worth reading.
  //
  // The library fetches all ten registers in one exchange and marks its cache fresh
  // before that exchange rather than after it succeeds. So a silent meter makes only the
  // first getter return NAN; the other five fall inside the cache window and hand back
  // zeros. That is how a meter nobody was talking to reported "current 0.000, power 0.0"
  // beside a null voltage, which reads exactly like a healthy sensor on an idle line.
  r.voltage = pzem.voltage();
  if (isnan(r.voltage)) return r;

  r.current = pzem.current();
  r.power = pzem.power();
  r.energy = pzem.energy();
  r.frequency = pzem.frequency();
  r.powerFactor = pzem.pf();
  return r;
}
