#pragma once

#include <Arduino.h>

// Reset reason, plus state kept in RTC memory across resets (but not power cycles).
namespace Boot {

void begin();

const char *resetReason();

uint32_t brownoutsInARow();

void markStable();

// Highest relay command id applied, so a redelivered command is not applied twice.
uint32_t lastCommandId();
void setLastCommandId(uint32_t id);

}  // namespace Boot
