#include "EnergyMeter.h"

EnergyMeter::EnergyMeter(HardwareSerial &serial, uint8_t rx, uint8_t tx)
    : serial(serial), rxPin(rx), txPin(tx), pzem(serial, rx, tx) {}

void EnergyMeter::begin() {
  serial.begin(9600, SERIAL_8N1, rxPin, txPin);
}

EnergyMeter::Reading EnergyMeter::read() {
  Reading r;

  // Voltage is read first and decides whether the rest is worth reading at all.
  //
  // The library fetches all ten registers in one exchange and caches them, but it
  // marks that cache fresh *before* the exchange rather than after it succeeds. So a
  // meter that does not answer makes only the first getter return NAN; the other five
  // fall inside the cache window, are told the data is current, and hand back
  // `_currentValues`, which is all zeros until some read has actually worked.
  //
  // That is how a meter nobody was talking to reported "current 0.000, power 0.0"
  // beside a null voltage: five fabricated zeros that read exactly like a healthy
  // sensor watching an idle line. Trusting them is worse than having no data, because
  // an idle line is indistinguishable from a dead one until the load is switched on.
  r.voltage = pzem.voltage();
  if (isnan(r.voltage)) return r;

  r.current = pzem.current();
  r.power = pzem.power();
  r.energy = pzem.energy();
  r.frequency = pzem.frequency();
  r.powerFactor = pzem.pf();
  return r;
}
