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
  // holding open.
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
  // Judged on the contacts rather than the lockout, so the button also works during the
  // wait after an ordinary trip.
  if (status != STATUS_OVERLOAD) return;

  // Refused, not queued: this is a repeat press arriving before the board has finished
  // deciding on the last one.
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

bool Monitor::setTripConfirm(unsigned long seconds) {
  if (seconds < MIN_TRIP_CONFIRM_SECONDS || seconds > MAX_TRIP_CONFIRM_SECONDS) return false;

  tripConfirmMs = seconds * 1000UL;
  return true;
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

  // Said once per change rather than once per sample. Whether the meter is talking is
  // the first question when the numbers look wrong.
  const bool answering = !isnan(voltage);
  if (answering != meterAnswering) {
    meterAnswering = answering;
    Serial.println(answering ? "PZEM answering"
                             : "PZEM stopped answering: check its AC supply, the 5V "
                               "and GND to the module, and that its TX goes to the "
                               "board's RX");
  }

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
        // The crossing itself, not the state, so the post goes out now instead of
        // waiting for the next scheduled one.
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
      // The confirm timer restarts the moment the load falls back, so separate brief
      // excursions cannot accumulate into a trip.
      if (!overTrip()) {
        overTripSince = 0;
        break;
      }
      if (overTripSince == 0) overTripSince = now;
      if (now - overTripSince >= tripConfirmMs) {
        status = STATUS_OVERLOAD;
        trippedAt = now;

        // Overriding an operator who closed it moments ago, so make them wait before
        // asking again. Protection outranks the request; the wait just stops the two
        // fighting several times a second.
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
  const bool shouldClose = status != STATUS_OVERLOAD;
  const bool changed = relay.isClosed() != shouldClose;

  // Driven every pass rather than only on the edge. Writing once asks the hardware to
  // hold a level for as long as the board runs, and a brownout or a write that did not
  // latch would leave the contacts disagreeing with the machine forever. One register
  // write a second, depending on nothing else working.
  relay.set(shouldClose);

  if (changed) {
    Serial.print("relay ");
    Serial.print(shouldClose ? "CLOSED" : "OPEN");
    Serial.print(", P");
    Serial.print(relay.number());
    Serial.println(shouldClose ? " driven LOW" : " driven HIGH");
    return;
  }

  // Open contacts, current still flowing. The pin was re-driven above on this pass and
  // every other, so a contact still conducting is welded rather than glitching, and
  // saying so is all that is left.
  if (!shouldClose && contactsStuck()) {
    Serial.println("current flowing with the relay open, contacts may be welded");
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

  // Heap health: does this last a month on a transformer or an afternoon on a bench.
  // Read the three together. `free` sliding down on its own is a leak; `free` steady
  // while `largest` sinks is fragmentation, which is likelier here because every TLS
  // context comes out of the same pool. `min_free` is the low water mark since boot.
  doc["heap_free"] = ESP.getFreeHeap();
  doc["heap_largest"] = ESP.getMaxAllocHeap();
  doc["heap_min_free"] = ESP.getMinFreeHeap();

  serializeJson(doc, Serial);
  Serial.println();
}

void Monitor::showLcd() {
  // Four rows of twenty: what the board thinks, what it measured, how close each limit
  // is. Each threshold sits beside the value it judges, so a change made in the app is
  // visible at the panel. formatFloat renders a missing measurement as "--" rather than
  // nan, and show() truncates rather than wraps if a row overruns.
  String header = "VITAL";
  String status = statusName();
  while (header.length() + status.length() < lcd.width()) header += ' ';
  header += status;

  String measured =
      "V:" + Lcd::formatFloat(voltage, 1) + "  A:" + Lcd::formatFloat(current, 3);

  // Against the trip, not the alarm: this row answers "how close is the load to being
  // cut". The alarm level announces itself as WARNING in the header.
  String load = "VA:" + Lcd::formatFloat(apparentPower, 0) + "/" + String((int)tripLimit);
  if (!isnan(apparentPower) && tripLimit > 0.0f) {
    load += "  " + String((int)(apparentPower / tripLimit * 100.0f)) + "%";
  }

  // Whether the load is energized is the one thing somebody at the box has to be able
  // to read without interpreting anything.
  String thermal = "T:" + Lcd::formatFloat(temperature, 1) + "/" + String((int)tempLimit) +
                   "C  RLY:" + (relay.isClosed() ? "ON" : "OFF");

  // The last row gives up the temperature whenever the relay is doing something, and
  // gets it back the moment the relay is idle again.
  const String relayLine = relayStatusLine();

  lcd.show(header, measured, load, relayLine.length() > 0 ? relayLine : thermal);
}

String Monitor::relayStatusLine() const {
  // "ADMIN" stays whole and the rest gives up its letters: the word that says a person
  // is needed is the wrong one to make them decode. Exactly 20 columns.
  if (lockedOut) return "RLY LOCK-NEEDS ADMIN";

  if (status == STATUS_OVERLOAD) {
    // Counts down rather than showing a deadline. Clamped at zero so the tail of the
    // wait reads "0s" instead of wrapping through unsigned subtraction.
    const unsigned long waited = millis() - trippedAt;
    const unsigned long left = waited >= recloseDelayMs ? 0 : (recloseDelayMs - waited) / 1000UL;

    // The attempt about to be made, not the count already spent, so it reads "3/3, last
    // one" instead of showing a 0 on the first wait.
    const uint8_t next = attempts < MAX_RECLOSE_ATTEMPTS ? attempts + 1 : MAX_RECLOSE_ATTEMPTS;

    return "OFF RETRY " + String(left) + "s " + String(next) + "/" +
           String(MAX_RECLOSE_ATTEMPTS);
  }

  // The confirm window: above the trip level and counting, contacts still closed. The
  // only warning anybody gets while there is still time to shed load.
  if (status == STATUS_WARNING && overTripSince != 0) {
    const unsigned long held = millis() - overTripSince;
    const unsigned long left = held >= tripConfirmMs ? 0 : (tripConfirmMs - held) / 1000UL + 1;

    return "TRIPPING IN " + String(left) + "s";
  }

  return String();
}
