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

  // Adopt the last thresholds seen so a reboot keeps the operator's values instead
  // of falling back to the compiled defaults until the first heartbeat lands.
  prefs.begin("vital", false);

#if CLEAR_SAVED_STATE
  prefs.clear();
  Serial.println("CLEAR_SAVED_STATE is on: wiped the saved trip, lockout and settings.");
  Serial.println("Set it back to 0 and reflash, or every boot discards them again.");
#endif

  monitor.setThresholds(prefs.getFloat("loadVa", 900.0f), prefs.getFloat("tripVa", 980.0f),
                        prefs.getFloat("tempC", 40.0f));

  // The reclose wait is remembered the same way, and for the same reason: a board that
  // cannot reach the backend would otherwise hold a fault open for the compiled thirty
  // seconds no matter what the operator set, and would revert to it on every reboot.
  //
  // The fallback is whatever the monitor already holds rather than a literal, so the
  // compiled default lives in one place. setRecloseDelay bounds-checks, so a corrupt
  // stored value leaves that default standing.
  monitor.setRecloseDelay(prefs.getUInt("recloseS", monitor.recloseDelaySeconds()));
  recloseSeconds = monitor.recloseDelaySeconds();

  monitor.setTripConfirm(prefs.getUInt("tripS", monitor.tripConfirmSeconds()));
  tripSeconds = monitor.tripConfirmSeconds();

  // A trip has to outlive a reboot, because a fault is exactly the condition that
  // browns out the supply. Coming back believing everything is fine would close
  // straight back into it.
  tripped = prefs.getBool("tripped", false);
  lockedOut = prefs.getBool("locked", false);
  if (tripped) {
    Serial.println(lockedOut ? "restored a lockout, load stays open until reset"
                             : "restored a trip from before the reboot, load stays open");
    monitor.restoreTrip(millis(), lockedOut);
  }

  // Said out loud on every boot, not only when something was restored. A relay that
  // will not close looks identical to a broken one from outside, and this is the line
  // that separates them: it names the state the contacts are driven from, before any
  // measurement has had a chance to change it.
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

  // After the link, since it prints the address it is reachable on and there is no
  // address before then.
  live.begin();
}

void Main::loop() {
  unsigned long now = millis();

  monitor.loop(now);

  // Noticed on the edge, written later. The flash sees one write per trip and one per
  // reclose rather than one per sample, and none of them in the pass that just moved
  // the contacts.
  if (monitor.isTripped() != tripped) {
    tripped = monitor.isTripped();
    trippedDirty = true;
    persistAt = now + PERSIST_SETTLE_MS;
  }

  // Kept separately from the trip. A trip is a state the board can leave on its own;
  // a lockout is one it cannot, so losing it to a reboot would quietly re-energise
  // the very fault it was holding open.
  if (monitor.isLockedOut() != lockedOut) {
    lockedOut = monitor.isLockedOut();
    lockedDirty = true;
    persistAt = now + PERSIST_SETTLE_MS;
    if (lockedOut) Serial.println("out of reclose attempts, load stays open until reset");
  }

  // One erase per pass, each pushing the next one out again, so an operator's off press
  // does not fire the coil and both flash writes inside the same few milliseconds.
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

  // Crossing the alarm level is posted the instant it is seen, on its own path and
  // off the schedule. On the interval alone the backend heard about an overload up to
  // POST_INTERVAL_MS late, and every one of those seconds is a second before anyone
  // is told. There is no timer here at all: it goes out in the same pass that saw it.
  if (monitor.takeAlarmEdge() && online) post(now);

  // The record of the run, unchanged and deliberately not reset by the line above, so
  // rows stay evenly spaced whether or not an alarm interrupted them.
  //
  // This interval is what decides how often a row is stored: in hardware mode the API
  // keeps every reading it is given, so the board's cadence is the database's. It is
  // not a display rate, and lowering it is paid for in rows and invocations rather
  // than in how quickly an overload is noticed, which no longer waits for it at all.
  if (now - lastPost >= POST_INTERVAL_MS) {
    lastPost = now;
    if (online) post(now);
  }

  // Served every pass and never waited on, so a caller cannot hold up the sampling
  // or the trip timer that share this loop.
  live.loop();

  if (now - lastHeartbeat >= HEARTBEAT_INTERVAL_MS) {
    lastHeartbeat = now;
    if (online) {
      BackendClient::HeartbeatResult ack = backend.postHeartbeat(monitor.isLockedOut());
      applyThresholds(ack);

      if (ack.ok) {
        // Set before the command is acted on, so a close that follows a delay change
        // in the same response waits the new interval rather than the old one.
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
  if (command == BackendClient::RELAY_NONE) return;

  const bool before = monitor.relayClosed();

  // An operator has been to look and says what to do. The board cannot reach either
  // conclusion itself: closing is the whole reason it locked out, and opening on
  // request is the manual override that protection never grants.
  switch (command) {
    case BackendClient::RELAY_CLOSE: monitor.closeByOperator(now); break;
    case BackendClient::RELAY_OPEN: monitor.openByOperator(now); break;
    case BackendClient::RELAY_NONE: break;
  }

  if (monitor.relayClosed() == before) return;

  // Report the new position at once instead of waiting out the interval.
  //
  // The command arrived on the response to a post that was sent before the contacts
  // moved, so that post still described the old position. Left alone, the app would
  // not learn the relay had switched until the following one, which doubles the wait
  // it shows an operator: up to ten seconds for a relay that moved in under one.
  //
  // Backdating rather than posting from here keeps the request on the one path in
  // loop() that owns it, and it is safe to underflow: the comparison there is
  // subtraction on unsigned values, which wraps to the right answer.
  lastPost = now - POST_INTERVAL_MS;
}

void Main::applyRecloseDelay(const BackendClient::HeartbeatResult &ack) {
  // Zero is how the client spells "the response did not carry one", which is what an
  // older backend or an unparseable body looks like. Keep what we have.
  if (!ack.ok || ack.recloseDelaySeconds == 0) return;
  if (ack.recloseDelaySeconds == recloseSeconds) return;

  if (!monitor.setRecloseDelay(ack.recloseDelaySeconds)) {
    Serial.print("rejected out of range reclose delay: ");
    Serial.println(ack.recloseDelaySeconds);
    return;
  }

  // Written only after the monitor took it, so a value refused for being out of range
  // never becomes the one that survives the next reboot.
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
  // Checked on the board as well as in the API, because this is the pair that
  // decides when the load is cut and the response arrives over a TLS connection
  // whose certificate is not validated. A trip at or below the alarm would open the
  // relay during load the operator meant to merely be warned about.
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
