// Reads the PZEM-004T every 2 s. It only answers with live AC on its voltage terminals.
#include <PZEM004Tv30.h>

#include "../../src/Config.h"

PZEM004Tv30 pzem(Serial2, PZEM_RX_PIN, PZEM_TX_PIN);
uint32_t attempts = 0, answered = 0;

void setup() {
  Serial.begin(115200);
  Serial2.begin(9600, SERIAL_8N1, PZEM_RX_PIN, PZEM_TX_PIN);
  Serial.println("PZEM test: PZEM TX to P16, RX to P17");
}

void loop() {
  delay(2000);
  attempts++;
  const float v = pzem.voltage();
  if (isnan(v)) {
    Serial.printf("no answer (%lu/%lu): check live AC, 5V/GND, and TX/RX not swapped\n", answered, attempts);
    return;
  }
  answered++;
  Serial.printf("V=%.1f A=%.3f W=%.1f kWh=%.3f Hz=%.1f PF=%.2f  (%lu/%lu)\n", v, pzem.current(), pzem.power(),
                pzem.energy(), pzem.frequency(), pzem.pf(), answered, attempts);
}
