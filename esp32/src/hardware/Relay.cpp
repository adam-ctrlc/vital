#include "Relay.h"

Relay::Relay(uint8_t pin, uint8_t onLevel, uint8_t offLevel)
    // Open until begin() runs: the pin is still an input held high by its pull-up,
    // which on an active low module is the de-energized state.
    : pin(pin), onLevel(onLevel), offLevel(offLevel), closed_(false) {}

void Relay::begin() {
  pinMode(pin, OUTPUT);
  set(false);
}

void Relay::set(bool closed) {
  closed_ = closed;
  digitalWrite(pin, closed ? onLevel : offLevel);
}
