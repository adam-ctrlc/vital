#include "Main.h"

#include <WiFi.h>

Main::Main()
    : lcd(LCD_SDA_PIN, LCD_SCL_PIN, LCD_COLS, LCD_ROWS),
      backend(),
      net(lcd),
      meter(Serial2, PZEM_RX_PIN, PZEM_TX_PIN),
      probe(DS18B20_PIN),
      relay(RELAY_PIN, RELAY_ON, RELAY_OFF),
      monitor(meter, probe, relay, lcd) {}

void Main::begin() {
  Serial.begin(115200);
  monitor.begin();

  // Adopt the last thresholds seen, so a reboot keeps the operator's values instead of
  // running on the compiled defaults until the first heartbeat lands.
  prefs.begin("vital", false);

#if CLEAR_SAVED_STATE
  prefs.clear();
  Serial.println("CLEAR_SAVED_STATE is on: wiped the saved trip, lockout and settings.");
  Serial.println("Set it back to 0 and reflash, or every boot discards them again.");
#endif

  monitor.setThresholds(prefs.getFloat("loadVa", 900.0f), prefs.getFloat("tripVa", 980.0f),
                        prefs.getFloat("tempC", 40.0f));

  // The waits are remembered the same way, or an offline board would revert to the
  // compiled thirty seconds on every reboot no matter what the operator set. The
  // fallback is whatever the monitor already holds, so the default lives in one place,
  // and the setters bounds-check, so a corrupt stored value leaves it standing.
  monitor.setRecloseDelay(prefs.getUInt("recloseS", monitor.recloseDelaySeconds()));
  recloseSeconds = monitor.recloseDelaySeconds();

  monitor.setTripConfirm(prefs.getUInt("tripS", monitor.tripConfirmSeconds()));
  tripSeconds = monitor.tripConfirmSeconds();

  // A trip has to outlive a reboot, because a fault is exactly what browns out the
  // supply. Coming back believing everything is fine would close straight into it.
  tripped = prefs.getBool("tripped", false);
  lockedOut = prefs.getBool("locked", false);
  if (tripped) {
    Serial.println(lockedOut ? "restored a lockout, load stays open until reset"
                             : "restored a trip from before the reboot, load stays open");
    monitor.restoreTrip(millis(), lockedOut);
  }

  // Printed on every boot, not only when something was restored. A relay held open on
  // purpose looks identical to a broken one, and this is the line that tells them apart.
  Serial.print("boot: tripped=");
  Serial.print(tripped ? "yes" : "no");
  Serial.print(" lockedOut=");
  Serial.print(lockedOut ? "yes" : "no");
  Serial.print(" status=");
  Serial.print(monitor.statusLabel());
  Serial.print(" relay=");
  Serial.print(monitor.relayClosed() ? "CLOSED" : "OPEN");
  Serial.print(" alarm=");
  Serial.print(monitor.loadThreshold(), 0);
  Serial.print(" trip=");
  Serial.print(monitor.tripThreshold(), 0);
  Serial.print(" tripDelay=");
  Serial.print(monitor.tripConfirmSeconds());
  Serial.print("s recloseDelay=");
  Serial.print(monitor.recloseDelaySeconds());
  Serial.println("s");

  net.begin();
  net.connect();

  // After the link, since it prints the address it is reachable on.
  live.begin();
}

void Main::loop() {
  unsigned long now = millis();

  monitor.loop(now);

  // Noticed on the edge, written later, so the flash sees one write per trip rather
  // than one per sample, and none in the pass that just moved the contacts.
  if (monitor.isTripped() != tripped) {
    tripped = monitor.isTripped();
    trippedDirty = true;
    persistAt = now + PERSIST_SETTLE_MS;
  }

  // Stored apart from the trip. A trip is a state the board can leave on its own; a
  // lockout is one it cannot, so losing it to a reboot would re-energize the fault.
  if (monitor.isLockedOut() != lockedOut) {
    lockedOut = monitor.isLockedOut();
    lockedDirty = true;
    persistAt = now + PERSIST_SETTLE_MS;
    if (lockedOut) Serial.println("out of reclose attempts, load stays open until reset");
  }

  // One erase per pass, each pushing the next out again, so an off press does not fire
  // the coil and both flash writes within the same few milliseconds.
  if ((trippedDirty || lockedDirty) && (long)(now - persistAt) >= 0) {
    if (trippedDirty) {
      trippedDirty = false;
      prefs.putBool("tripped", tripped);
    } else {
      lockedDirty = false;
      prefs.putBool("locked", lockedOut);
    }
    persistAt = now + PERSIST_SETTLE_MS;
  }

  if (WiFi.status() != WL_CONNECTED && now - lastReconnect >= RECONNECT_INTERVAL_MS) {
    lastReconnect = now;
    net.connect();
  }

  bool online = WiFi.status() == WL_CONNECTED;

  // Crossing the alarm level goes out in the same pass that saw it, off the schedule.
  // On the interval alone the backend heard about an overload up to five seconds late.
  if (monitor.takeAlarmEdge() && online) post(now);

  // The record of the run, deliberately not reset by the line above so rows stay evenly
  // spaced whether or not an alarm interrupted them. The API keeps every reading it is
  // given, so this interval is what decides how often a row is stored.
  if (now - lastPost >= POST_INTERVAL_MS) {
    lastPost = now;
    if (online) post(now);
  }

  // Never waited on, so a caller cannot hold up the sampling or the trip timer that
  // share this loop.
  live.loop();

  if (now - lastHeartbeat >= HEARTBEAT_INTERVAL_MS) {
    lastHeartbeat = now;
    if (online) {
      BackendClient::HeartbeatResult ack = backend.postHeartbeat(monitor.isLockedOut());
      applyThresholds(ack);

      if (ack.ok) {
        // Before the command is acted on, so a close arriving with a delay change in
        // the same response waits the new interval.
        applyRecloseDelay(ack);
        applyTripConfirm(ack);

        applyRelayCommand(ack.relayCommand, now);
      }
    }
  }
}

void Main::post(unsigned long now) {
  Monitor::Snapshot s = monitor.snapshot();
  const BackendClient::ReadingResult result =
      backend.postReading(s.voltage, s.current, s.temperature, s.power, s.powerFactor,
                          s.frequency, s.energy, monitor.relayClosed());

  if (result.ok) applyRelayCommand(result.relayCommand, now);
}

void Main::applyRelayCommand(BackendClient::RelayCommand command, unsigned long now) {
  // An operator has been to look and says what to do. The board cannot reach either
  // conclusion itself.
  switch (command) {
    case BackendClient::RELAY_CLOSE: monitor.closeByOperator(now); break;
    case BackendClient::RELAY_OPEN: monitor.openByOperator(now); break;
    case BackendClient::RELAY_NONE: break;
  }
}

void Main::applyRecloseDelay(const BackendClient::HeartbeatResult &ack) {
  // Zero means the response did not carry one, which is what an older backend or an
  // unparseable body looks like. Keep what we have.
  if (!ack.ok || ack.recloseDelaySeconds == 0) return;
  if (ack.recloseDelaySeconds == recloseSeconds) return;

  if (!monitor.setRecloseDelay(ack.recloseDelaySeconds)) {
    Serial.print("rejected out of range reclose delay: ");
    Serial.println(ack.recloseDelaySeconds);
    return;
  }

  // Written only after the monitor took it, so a rejected value never becomes the one
  // that survives the next reboot.
  recloseSeconds = ack.recloseDelaySeconds;
  prefs.putUInt("recloseS", recloseSeconds);

  Serial.print("reclose delay updated -> ");
  Serial.print(recloseSeconds);
  Serial.println("s");
}

void Main::applyTripConfirm(const BackendClient::HeartbeatResult &ack) {
  if (!ack.ok || ack.tripConfirmSeconds == 0) return;
  if (ack.tripConfirmSeconds == tripSeconds) return;

  if (!monitor.setTripConfirm(ack.tripConfirmSeconds)) {
    Serial.print("rejected out of range trip delay: ");
    Serial.println(ack.tripConfirmSeconds);
    return;
  }

  tripSeconds = ack.tripConfirmSeconds;
  prefs.putUInt("tripS", tripSeconds);

  Serial.print("trip delay updated -> ");
  Serial.print(tripSeconds);
  Serial.println("s");
}

void Main::applyThresholds(const BackendClient::HeartbeatResult &ack) {
  if (!ack.ok) return;

  float va = ack.loadThresholdVa;
  float trip = ack.tripThresholdVa;
  float temp = ack.tempThresholdC;
  if (isnan(va) || isnan(trip) || isnan(temp)) return;
  if (va < MIN_LOAD_THRESHOLD_VA || va > MAX_LOAD_THRESHOLD_VA) {
    Serial.print("rejected out of range load threshold: ");
    Serial.println(va, 0);
    return;
  }
  if (trip < MIN_LOAD_THRESHOLD_VA || trip > MAX_LOAD_THRESHOLD_VA) {
    Serial.print("rejected out of range trip threshold: ");
    Serial.println(trip, 0);
    return;
  }
  // Checked here as well as in the API: this is the pair that decides when the load is
  // cut, and a trip at or below the alarm would open the relay on load the operator
  // only meant to be warned about.
  if (trip <= va) {
    Serial.print("rejected trip threshold not above the alarm: ");
    Serial.print(trip, 0);
    Serial.print(" <= ");
    Serial.println(va, 0);
    return;
  }
  if (temp < MIN_TEMP_THRESHOLD_C || temp > MAX_TEMP_THRESHOLD_C) {
    Serial.print("rejected out of range temp threshold: ");
    Serial.println(temp, 0);
    return;
  }

  if (fabs(va - monitor.loadThreshold()) < 0.05f &&
      fabs(trip - monitor.tripThreshold()) < 0.05f &&
      fabs(temp - monitor.tempThreshold()) < 0.05f) {
    return;
  }

  monitor.setThresholds(va, trip, temp);
  prefs.putFloat("loadVa", va);
  prefs.putFloat("tripVa", trip);
  prefs.putFloat("tempC", temp);

  Serial.print("thresholds updated -> ALARM:");
  Serial.print(va, 0);
  Serial.print(" TRIP:");
  Serial.print(trip, 0);
  Serial.print(" TEMP:");
  Serial.println(temp, 0);
}
