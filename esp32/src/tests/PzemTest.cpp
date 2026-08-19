#include "PzemTest.h"

PzemTest::PzemTest()
    : meter(Serial2, PZEM_RX_PIN, PZEM_TX_PIN),
      relay(RELAY_PIN, RELAY_ON, RELAY_OFF) {}

void PzemTest::begin() {
  Serial.begin(115200);
  delay(200);
  Serial.println();
  Serial.println("PZEM test");
  Serial.println("Wiring: PZEM TX to P16, PZEM RX to P17, 5V, GND. Relay on P18.");

  meter.begin();
  relay.begin();
}

void PzemTest::loop() {
  unsigned long now = millis();

  if (now - lastToggle >= TOGGLE_INTERVAL_MS) {
    lastToggle = now;
    relay.set(!relay.isClosed());
    Serial.print("relay ");
    Serial.println(relay.isClosed() ? "CLOSED" : "OPEN");
  }

  if (now - lastRead < READ_INTERVAL_MS) return;
  lastRead = now;

  EnergyMeter::Reading r = meter.read();
  Serial.print("V=");
  Serial.print(r.voltage, 1);
  Serial.print("  I=");
  Serial.print(r.current, 3);
  Serial.print("  P=");
  Serial.print(r.power, 1);
  Serial.print("W  E=");
  Serial.print(r.energy, 3);
  Serial.print("kWh  F=");
  Serial.print(r.frequency, 1);
  Serial.print("Hz  PF=");
  Serial.println(r.powerFactor, 2);
}
