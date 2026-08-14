#include "Monitor.h"

void Monitor::begin() {
  lcd.begin();
  relay.begin();
  meter.begin();
  probe.begin();
}

void Monitor::loop(unsigned long now) {
  if (!sampleDue(now)) return;

  bool sensorsOk = sample();
  updateStatus(now);
  applyRelay();
  publish(sensorsOk);
  showLcd();
}

void Monitor::restoreTrip(unsigned long now, bool wasLockedOut) {
  status = STATUS_OVERLOAD;
  trippedAt = now;
  // A lockout that did not survive the reboot would auto-close into the fault it was
  // holding open, which is the one outcome the lockout exists to prevent.
  lockedOut = wasLockedOut;
  attempts = wasLockedOut ? MAX_RECLOSE_ATTEMPTS : 0;
  applyRelay();
}

bool Monitor::takeAlarmEdge() {
  const bool crossed = alarmEdge;
  alarmEdge = false;

  return crossed;
}

void Monitor::closeByOperator(unsigned long now) {
  // Judged on the contacts rather than the lockout, so the button also works during
  // the wait after an ordinary trip. The old guard returned early there, leaving it
  // dead for the whole reclose delay.
  if (status != STATUS_OVERLOAD) return;

  // Refused, not queued. An operator whose close was undone a moment ago is asking
  // again before the board has finished deciding, and honouring that turns a
  // protection scheme into a switch that argues.
  if (manualBlockedUntil != 0 && (long)(now - manualBlockedUntil) < 0) {
    Serial.println("relay close refused, still within the retry wait");
    return;
  }

  Serial.println("relay closed by an operator");
  lockedOut = false;
  attempts = 0;
  closedAt = now;
  manualClosedAt = now;
  trippedAt = now - recloseDelayMs;
  status = STATUS_NORMAL;
  abnormalSince = 0;
  overTripSince = 0;
  applyRelay();
}

void Monitor::openByOperator(unsigned long now) {
  if (status == STATUS_OVERLOAD && lockedOut) return;

  Serial.println("relay opened by an operator");
  status = STATUS_OVERLOAD;
  trippedAt = now;
  lockedOut = true;
  attempts = MAX_RECLOSE_ATTEMPTS;
  closedAt = 0;
  manualClosedAt = 0;
  applyRelay();
}

bool Monitor::setRecloseDelay(unsigned long seconds) {
  if (seconds < MIN_RECLOSE_SECONDS || seconds > MAX_RECLOSE_SECONDS) return false;

  recloseDelayMs = seconds * 1000UL;
  return true;
}

void Monitor::setThresholds(float alarm, float trip, float temp) {
  vaLimit = alarm;
  tripLimit = trip;
  tempLimit = temp;
  tripClear = alarm;
  tempClear = temp > 3.0f ? temp - 3.0f : temp * 0.9f;
}

bool Monitor::sampleDue(unsigned long now) {
  if (now - lastSample < SAMPLE_INTERVAL_MS) return false;
  lastSample = now;
  return true;
}

bool Monitor::sample() {
  EnergyMeter::Reading r = meter.read();
  voltage = r.voltage;
  current = r.current;
  power = r.power;
  energy = r.energy;
  frequency = r.frequency;
  powerFactor = r.powerFactor;

  temperature = probe.read();

  if (isnan(voltage) || isnan(current)) {
    apparentPower = NAN;
    return false;
  }

  apparentPower = voltage * current;
  return true;
}

bool Monitor::overAlarm() {
  return (!isnan(apparentPower) && apparentPower >= vaLimit) ||
         (!isnan(temperature) && temperature >= tempLimit);
}

bool Monitor::overTrip() { return !isnan(apparentPower) && apparentPower >= tripLimit; }

bool Monitor::belowClear() { return !isnan(apparentPower) && apparentPower <= tripClear; }

void Monitor::updateStatus(unsigned long now) {
  // A reclose that has held for long enough is a recovery, not an attempt that has
  // yet to fail, so the count starts again from there.
  if (attempts > 0 && status != STATUS_OVERLOAD && closedAt != 0 &&
      now - closedAt >= RECLOSE_SURVIVED_MS) {
    attempts = 0;
    closedAt = 0;
  }

  switch (status) {
    case STATUS_NORMAL:
      if (overAlarm()) {
        status = STATUS_WARNING;
        abnormalSince = now;
        overTripSince = overTrip() ? now : 0;
        // The crossing itself, not the state. Waiting for the next scheduled post
        // would sit on this for up to the post interval before anyone was told.
        alarmEdge = true;
      }
      break;

    case STATUS_WARNING:
      if (!overAlarm()) {
        status = STATUS_NORMAL;
        abnormalSince = 0;
        overTripSince = 0;
        break;
      }
      // The confirm timer runs only while the load is actually above the trip level
      // and restarts the moment it falls back, so separate brief excursions cannot
      // accumulate into a trip between them.
      if (!overTrip()) {
        overTripSince = 0;
        break;
      }
      if (overTripSince == 0) overTripSince = now;
      if (now - overTripSince >= TRIP_CONFIRM_MS) {
        status = STATUS_OVERLOAD;
        trippedAt = now;

        // Overriding an operator who closed it moments ago, so make them wait before
        // asking again. Protection outranks the request every time; the wait only
        // stops the two fighting several times a second.
        if (manualClosedAt != 0 && now - manualClosedAt <= recloseDelayMs) {
          Serial.println("overload after a manual close, opening again");
          manualBlockedUntil = now + MANUAL_RETRY_MS;
          manualClosedAt = 0;
        }
      }
      break;

    case STATUS_OVERLOAD:
      // Locked out is a decision, not a timer. Only a person clears it.
      if (lockedOut) break;

      if (belowClear() && now - trippedAt >= recloseDelayMs) {
        if (attempts >= MAX_RECLOSE_ATTEMPTS) {
          lockedOut = true;
          break;
        }

        attempts += 1;
        closedAt = now;
        status = STATUS_NORMAL;
        abnormalSince = 0;
        overTripSince = 0;
      }
      break;
  }
}

void Monitor::applyRelay() {
  bool shouldClose = status != STATUS_OVERLOAD;

  // Normally written only on a change, so the pin is not hammered every cycle.
  if (relay.isClosed() != shouldClose) {
    relay.set(shouldClose);
    return;
  }

  // Except when the meter disagrees with us. We believe the contacts are open and
  // current is still flowing, so one of those is wrong, and the measurement is the
  // one with evidence behind it. Driving the pin again costs nothing and recovers
  // the case the cached state cannot see: a write that never landed, a module that
  // did not latch, a line that glitched.
  //
  // The board is active low, so this is a HIGH. Re-asserting through Relay rather
  // than writing the pin here is what keeps that detail in one place.
  if (!shouldClose && contactsStuck()) {
    Serial.println("current flowing with the relay open, re-asserting the trip");
    relay.set(false);
  }
}

const char *Monitor::statusName() {
  switch (status) {
    case STATUS_OVERLOAD: return "OVERLOAD";
    case STATUS_WARNING: return "WARNING";
    default: return "NORMAL";
  }
}

void Monitor::put(JsonDocument &doc, const char *key, float value, int digits) {
  if (isnan(value) || isinf(value)) {
    doc[key] = nullptr;
    return;
  }
  doc[key] = serialized(String(value, digits));
}

void Monitor::publish(bool sensorsOk) {
  JsonDocument doc;
  doc["status"] = statusName();
  doc["relay"] = relay.isClosed() ? "CLOSED" : "OPEN";
  doc["sensor_ok"] = sensorsOk;
  put(doc, "voltage_v", voltage, 1);
  put(doc, "current_a", current, 3);
  put(doc, "power_w", power, 1);
  put(doc, "apparent_va", apparentPower, 1);
  put(doc, "pf", powerFactor, 2);
  put(doc, "frequency_hz", frequency, 1);
  put(doc, "energy_kwh", energy, 3);
  put(doc, "temperature_c", temperature, 1);

  // Heap health, for the question this firmware could not otherwise answer: does it
  // last a month on a transformer, or only an afternoon on a bench.
  //
  // Read them together, because the two failure modes look different. `free` sliding
  // downward on its own is a leak. `free` holding steady while `largest` sinks is
  // fragmentation, and that is the likelier one here: every backend call builds and
  // tears down a TLS context of tens of KB, which on a board without PSRAM comes out
  // of the same pool as everything else. Once `largest` falls below what mbedTLS
  // needs, posts start failing while `free` still looks healthy.
  //
  // `min_free` is the low water mark since boot, so a spike that nearly exhausted the
  // heap is still visible afterwards rather than vanishing once it recovered.
  doc["heap_free"] = ESP.getFreeHeap();
  doc["heap_largest"] = ESP.getMaxAllocHeap();
  doc["heap_min_free"] = ESP.getMinFreeHeap();

  serializeJson(doc, Serial);
  Serial.println();
}

void Monitor::showLcd() {
  // Four rows of twenty, read top to bottom as headline then detail: what the board
  // thinks, what it measured, and how close each limit is. Both thresholds are on
  // screen beside the value they judge, so a change made in the app is visible on
  // the board without opening the app again.
  //
  // Every number goes through Lcd::formatFloat, which renders a missing measurement
  // as "--" rather than nan, so an unplugged sensor reads as absent instead of
  // broken. Widths are chosen to leave slack at twenty columns: the longest status
  // word is OVERLOAD, and show() truncates rather than wraps if anything overruns.
  String header = "VITAL";
  String status = statusName();
  while (header.length() + status.length() < lcd.width()) header += ' ';
  header += status;

  String measured =
      "V:" + Lcd::formatFloat(voltage, 1) + "  A:" + Lcd::formatFloat(current, 3);

  // Measured against the trip, not the alarm: this row answers "how close is the
  // load to being cut", and the alarm level announces itself as WARNING in the
  // header when it is crossed.
  String load = "VA:" + Lcd::formatFloat(apparentPower, 0) + "/" + String((int)tripLimit);
  if (!isnan(apparentPower) && tripLimit > 0.0f) {
    load += "  " + String((int)(apparentPower / tripLimit * 100.0f)) + "%";
  }

  // Relay state earns its place now that the contacts actually move. Whether the
  // load is energized is the one thing somebody standing at the box needs to read
  // off the panel without interpreting anything.
  String thermal = "T:" + Lcd::formatFloat(temperature, 1) + "/" + String((int)tempLimit) +
                   "C  RLY:" + (relay.isClosed() ? "ON" : "OFF");

  // The last row gives up the temperature whenever the relay is doing something,
  // because at that moment what the relay is about to do outranks a reading nobody
  // is going to act on. It comes back the moment the relay is idle again.
  const String relayLine = relayStatusLine();

  lcd.show(header, measured, load, relayLine.length() > 0 ? relayLine : thermal);
}

String Monitor::relayStatusLine() const {
  // "ADMIN" stays whole and the rest gives up the letters: the one word that tells
  // somebody this needs a person is the wrong one to make them decode. Exactly 20.
  if (lockedOut) return "RLY LOCK-NEEDS ADMIN";

  if (status == STATUS_OVERLOAD) {
    // Counts down rather than showing the deadline, because a millis() timestamp on
    // a panel is not information. Clamped at zero so the tail of the wait, and a
    // reclose held off because the load has not cleared yet, both read as "0s"
    // instead of wrapping to an enormous number through unsigned subtraction.
    const unsigned long waited = millis() - trippedAt;
    const unsigned long left = waited >= recloseDelayMs ? 0 : (recloseDelayMs - waited) / 1000UL;

    // The attempt about to be made rather than the count already spent, so the row
    // reads as "3/3, this is the last one" instead of showing a 0 on the first wait.
    // Clamped because the pass that finds the load still high at the final attempt
    // leaves the count at the maximum without incrementing it again.
    const uint8_t next = attempts < MAX_RECLOSE_ATTEMPTS ? attempts + 1 : MAX_RECLOSE_ATTEMPTS;

    return "OFF RETRY " + String(left) + "s " + String(next) + "/" +
           String(MAX_RECLOSE_ATTEMPTS);
  }

  // The confirm window: above the trip level and counting, contacts still closed.
  // This is the only warning anybody gets before the load goes away, so it says so
  // while there is still time to shed load and avoid the trip entirely.
  if (status == STATUS_WARNING && overTripSince != 0) {
    const unsigned long held = millis() - overTripSince;
    const unsigned long left = held >= TRIP_CONFIRM_MS ? 0 : (TRIP_CONFIRM_MS - held) / 1000UL + 1;

    return "TRIPPING IN " + String(left) + "s";
  }

  return String();
}
