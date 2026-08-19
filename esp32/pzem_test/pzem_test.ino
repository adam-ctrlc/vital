// PZEM bench test. Standalone: no relay, no LCD, no WiFi, no state machine. If the
// meter does not answer here, nothing in the firmware can be the reason.
//
// Wiring, the same pins the firmware uses:
//   PZEM TX -> P16        PZEM 5V  -> 5V
//   PZEM RX -> P17        PZEM GND -> GND
//
// The PZEM-004T v3.0 measures the AC line AND draws its measuring side from it. With
// no live AC on the voltage terminals it will not answer Modbus at all, however good
// the serial wiring is. That is the first thing this test tells you apart.
//
// It also calls voltage() twice on purpose. The library marks its 200 ms cache fresh
// before the exchange rather than after it succeeds, so one failed transaction makes
// the first getter return NAN while the rest quietly serve a cache of zeros. Reading
// the same value twice separates "the meter is silent" from "one exchange was lost".

#include <Arduino.h>
#include <PZEM004Tv30.h>

#define PZEM_RX_PIN 16
#define PZEM_TX_PIN 17

#define READ_INTERVAL_MS 2000

PZEM004Tv30 pzem(Serial2, PZEM_RX_PIN, PZEM_TX_PIN);

unsigned long lastRead = 0;
uint32_t attempts = 0;
uint32_t answered = 0;

void show(const char *label, float value, int digits, const char *unit) {
  Serial.print(label);
  if (isnan(value)) {
    Serial.print("--");
  } else {
    Serial.print(value, digits);
  }
  Serial.print(unit);
}

void setup() {
  Serial.begin(115200);
  delay(200);
  Serial.println();
  Serial.println("PZEM bench test");
  Serial.println("Wiring: PZEM TX -> P16, PZEM RX -> P17, 5V, GND.");
  Serial.println("The meter needs live AC on its voltage terminals to answer at all.");
  Serial.println("Reading every 2 seconds.");

  Serial2.begin(9600, SERIAL_8N1, PZEM_RX_PIN, PZEM_TX_PIN);
  lastRead = millis();
}

void loop() {
  if (millis() - lastRead < READ_INTERVAL_MS) return;
  lastRead = millis();
  attempts++;

  // Two shots at the exchange that matters. The second one starts with a clean
  // buffer, so a single lost frame shows up as "recovered on retry" rather than as
  // a dead meter.
  float voltage = pzem.voltage();
  const bool retried = isnan(voltage);
  if (retried) voltage = pzem.voltage();

  if (isnan(voltage)) {
    Serial.print("attempt ");
    Serial.print(attempts);
    Serial.print(": no answer");
    Serial.print("   answered so far ");
    Serial.print(answered);
    Serial.print("/");
    Serial.println(attempts);
    Serial.println("  -> check: live AC on the voltage terminals, 5V and GND to the");
    Serial.println("     module, and TX/RX not swapped (PZEM TX goes to P16).");
    return;
  }

  answered++;

  show("V=", voltage, 1, "");
  show("  I=", pzem.current(), 3, "A");
  show("  P=", pzem.power(), 1, "W");
  show("  E=", pzem.energy(), 3, "kWh");
  show("  F=", pzem.frequency(), 1, "Hz");
  show("  PF=", pzem.pf(), 2, "");
  if (retried) Serial.print("   (first exchange lost, recovered on retry)");
  Serial.print("   answered ");
  Serial.print(answered);
  Serial.print("/");
  Serial.println(attempts);
}
