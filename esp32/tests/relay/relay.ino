// Toggles the relay every 3 s. Listen for the click and check the module's LED.
#include "../../src/Config.h"

bool closed = false;

void setup() {
  Serial.begin(115200);
  pinMode(RELAY_PIN, OUTPUT);
  Serial.printf("relay test on P%d, %s\n", RELAY_PIN, RELAY_VIA_TRANSISTOR ? "via transistor (close = HIGH)" : "direct (close = LOW)");
}

void loop() {
  closed = !closed;
  const bool high = RELAY_VIA_TRANSISTOR ? closed : !closed;
  digitalWrite(RELAY_PIN, high ? HIGH : LOW);
  Serial.printf("relay %s, pin %s\n", closed ? "CLOSED" : "OPEN", high ? "HIGH" : "LOW");
  delay(3000);
}
