#include "Settings.h"

#include "../Config.h"

void Settings::begin() {
  prefs.begin("vital", false);
#if CLEAR_SAVED_STATE
  prefs.clear();
  Serial.println("CLEAR_SAVED_STATE is on: wiped the saved trip, lockout and settings. Set it back to 0.");
#endif
}

void Settings::load(Protection &protection, uint32_t now) {
  const Protection::Limits defaults = protection.limits();
  protection.setLimits({prefs.getFloat("loadVa", defaults.alarmVa), prefs.getFloat("tripVa", defaults.tripVa),
                        prefs.getFloat("tempC", defaults.tempC)});
  protection.setTripDelaySeconds(prefs.getUInt("tripS", protection.tripDelaySeconds()));
  protection.setRecloseDelaySeconds(prefs.getUInt("recloseS", protection.recloseDelaySeconds()));
  protection.restore(prefs.getBool("tripped", false), prefs.getBool("locked", false), now);
}

void Settings::saveLimits(const Protection::Limits &limits) {
  prefs.putFloat("loadVa", limits.alarmVa);
  prefs.putFloat("tripVa", limits.tripVa);
  prefs.putFloat("tempC", limits.tempC);
}
