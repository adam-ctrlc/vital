#pragma once

#include <Preferences.h>

#include "Protection.h"

// Limits, delays and a trip or lockout, in flash. Keys unchanged from the old firmware.
class Settings {
 public:
  void begin();

  void load(Protection &protection, uint32_t now);

  void saveLimits(const Protection::Limits &limits);
  void saveTripDelay(uint32_t seconds) { prefs.putUInt("tripS", seconds); }
  void saveRecloseDelay(uint32_t seconds) { prefs.putUInt("recloseS", seconds); }
  void saveTripped(bool tripped) { prefs.putBool("tripped", tripped); }
  void saveLockedOut(bool lockedOut) { prefs.putBool("locked", lockedOut); }

 private:
  Preferences prefs;
};
