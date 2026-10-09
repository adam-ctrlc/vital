#include "Controller.h"

#include <esp_task_wdt.h>

#include "Boot.h"

static constexpr float STUCK_CONTACT_AMPS = 0.15f;
static constexpr uint32_t LOG_INTERVAL_MS = 5000;

static bool reached(uint32_t now, uint32_t at) { return (int32_t)(now - at) >= 0; }

void Controller::begin() {
  relay.begin();
  lcd.begin();
  sensors.begin();
  settings.begin();

  const uint32_t now = millis();
  protection.setCurrentTripAmps(CURRENT_TRIP_AMPS);
  protection.setInstantTripAmps(INSTANT_TRIP_AMPS);
  settings.load(protection, now);
  savedTripped = protection.tripped();
  savedLockedOut = protection.lockedOut();

  const uint32_t brownouts = Boot::brownoutsInARow();
  if (brownouts > 0) {
    const uint32_t hold = min<uint32_t>(brownouts, BROWNOUT_HOLD_MAX_COUNT) * BROWNOUT_HOLD_MS;
    protection.holdOpenUntil(now + hold);
    Serial.printf("brownout reset #%lu: relay held open %lus\n", (unsigned long)brownouts, (unsigned long)(hold / 1000));
  }

  const Protection::Limits &l = protection.limits();
  Serial.printf("protection: %s%s alarm=%.0f trip=%.0f temp=%.0f tripDelay=%lus recloseDelay=%lus\n",
                Protection::label(protection.state()), protection.lockedOut() ? " (locked out)" : "", l.alarmVa,
                l.tripVa, l.tempC, (unsigned long)protection.tripDelaySeconds(),
                (unsigned long)protection.recloseDelaySeconds());

  commands = xQueueCreate(8, sizeof(Command));
  publish();
  xTaskCreatePinnedToCore(taskEntry, "protection", 8192, this, PROTECTION_TASK_PRIORITY, nullptr, PROTECTION_TASK_CORE);
}

Snapshot Controller::snapshot() const {
  taskENTER_CRITICAL(&lock);
  Snapshot copy = shared;
  taskEXIT_CRITICAL(&lock);
  return copy;
}

void Controller::send(const Command &command) {
  if (xQueueSend(commands, &command, 0) != pdTRUE) Serial.println("protection busy, command dropped");
}

void Controller::taskEntry(void *self) { static_cast<Controller *>(self)->run(); }

void Controller::run() {
  // A hang resets the board, which comes back with the relay open and the trip restored.
  esp_task_wdt_config_t watchdog = {.timeout_ms = PROTECTION_WATCHDOG_MS, .idle_core_mask = 0, .trigger_panic = true};
  if (esp_task_wdt_reconfigure(&watchdog) != ESP_OK) esp_task_wdt_init(&watchdog);
  esp_task_wdt_add(nullptr);

  uint32_t nextSample = millis();
  for (;;) {
    // Commands wake the task at once; otherwise it sleeps until the next sample.
    uint32_t now = millis();
    uint32_t wakeAt = nextSample;
    if ((savedTripped != protection.tripped() || savedLockedOut != protection.lockedOut()) &&
        (int32_t)(persistAt - wakeAt) < 0) {
      wakeAt = persistAt;
    }
    const TickType_t wait = reached(now, wakeAt) ? 0 : pdMS_TO_TICKS(wakeAt - now);

    Command command;
    if (xQueueReceive(commands, &command, wait) == pdTRUE) apply(command, millis());

    now = millis();
    if (reached(now, nextSample)) {
      nextSample = now + SAMPLE_INTERVAL_MS;
      sample(now);
    }
    driveRelay(now);
    persist(now);
    publish();
    esp_task_wdt_reset();
  }
}

void Controller::sample(uint32_t now) {
  reading = sensors.read();
  const bool wasInstant = protection.instantTripped();
  protection.update(reading.apparentPower(), reading.current, reading.temperature, now);
  if (protection.instantTripped() && !wasInstant) {
    Serial.printf("INSTANT TRIP: %.2f A at or above %.2f A, locked out\n", reading.current, INSTANT_TRIP_AMPS);
  }
  if (protection.takeAlarmEdge()) changes++;

  if (!stable && now >= STABLE_AFTER_MS) {
    stable = true;
    Boot::markStable();
  }
  show(now);
  log(now);
}

void Controller::apply(const Command &command, uint32_t now) {
  switch (command.kind) {
    case Command::Open:
      protection.operatorOpen(now);
      Serial.println("relay opened by an operator");
      break;
    case Command::Close:
      Serial.println(protection.operatorClose(now) ? "relay closed by an operator"
                                                   : "close refused: not tripped, or the protection just reopened it");
      break;
    case Command::SetLimits:
      if (protection.setLimits(command.limits)) {
        settings.saveLimits(command.limits);
        Serial.printf("limits: alarm=%.0f trip=%.0f temp=%.0f\n", command.limits.alarmVa, command.limits.tripVa,
                      command.limits.tempC);
      } else {
        Serial.println("rejected limits out of range (trip must be above alarm)");
      }
      break;
    case Command::SetTripDelay:
      if (protection.setTripDelaySeconds(command.seconds)) settings.saveTripDelay(command.seconds);
      Serial.printf("trip delay %lus %s\n", (unsigned long)command.seconds,
                    protection.tripDelaySeconds() == command.seconds ? "set" : "rejected");
      break;
    case Command::SetRecloseDelay:
      if (protection.setRecloseDelaySeconds(command.seconds)) settings.saveRecloseDelay(command.seconds);
      Serial.printf("reclose delay %lus %s\n", (unsigned long)command.seconds,
                    protection.recloseDelaySeconds() == command.seconds ? "set" : "rejected");
      break;
  }
  show(now);
}

void Controller::driveRelay(uint32_t now) {
  const bool close = protection.shouldClose(now);
  if (close != relay.closed()) {
    Serial.printf("relay %s (%s)\n", close ? "CLOSED" : "OPEN", Protection::label(protection.state()));
    changes++;
    persistAt = now + PERSIST_SETTLE_MS;
  }
  relay.set(close);

  if (!close && reading.current >= STUCK_CONTACT_AMPS && now - lastStuckWarning >= 10000) {
    lastStuckWarning = now;
    Serial.println("current flowing with the relay open: the contacts may be welded");
  }
}

void Controller::persist(uint32_t now) {
  if (!reached(now, persistAt)) return;
  if (savedTripped != protection.tripped()) {
    savedTripped = protection.tripped();
    settings.saveTripped(savedTripped);
    persistAt = now + PERSIST_SETTLE_MS;
  } else if (savedLockedOut != protection.lockedOut()) {
    savedLockedOut = protection.lockedOut();
    settings.saveLockedOut(savedLockedOut);
    if (savedLockedOut) Serial.println("out of reclose attempts: the relay stays open until an operator closes it");
  }
}

void Controller::publish() {
  Snapshot next;
  next.reading = reading;
  next.state = protection.state();
  next.relayClosed = relay.closed();
  next.lockedOut = protection.lockedOut();
  next.limits = protection.limits();
  next.tripDelaySeconds = protection.tripDelaySeconds();
  next.recloseDelaySeconds = protection.recloseDelaySeconds();
  next.changes = changes;

  taskENTER_CRITICAL(&lock);
  shared = next;
  taskEXIT_CRITICAL(&lock);
}

static const char *num(char *out, size_t size, float value, int digits) {
  if (isnan(value)) return "--";
  snprintf(out, size, "%.*f", digits, value);
  return out;
}

void Controller::show(uint32_t now) {
  char a[12], b[12];
  char rows[LCD_ROWS][48];
  const char *state = Protection::label(protection.state());
  const float va = reading.apparentPower();
  const Protection::Limits &l = protection.limits();

  snprintf(rows[0], sizeof rows[0], "%-*s%s", LCD_COLS - (int)strlen(state), online_ ? "VITAL" : "NO WIFI", state);
  snprintf(rows[1], sizeof rows[1], "V:%s  A:%s", num(a, sizeof a, reading.voltage, 1), num(b, sizeof b, reading.current, 3));
  if (isnan(va)) {
    snprintf(rows[2], sizeof rows[2], "VA:--/%d", (int)l.tripVa);
  } else {
    snprintf(rows[2], sizeof rows[2], "VA:%d/%d  %d%%", (int)va, (int)l.tripVa, (int)(va / l.tripVa * 100));
  }

  if (uint32_t held = protection.secondsHeldOpen(now)) {
    snprintf(rows[3], sizeof rows[3], "POWER DIP, WAIT %lus", (unsigned long)held);
  } else if (protection.instantTripped()) {
    snprintf(rows[3], sizeof rows[3], "OVERCURRENT LOCKOUT");
  } else if (protection.lockedOut()) {
    snprintf(rows[3], sizeof rows[3], "RLY LOCK-NEEDS ADMIN");
  } else if (protection.tripped()) {
    const unsigned next = min<unsigned>(protection.attempts() + 1, Protection::MAX_RECLOSE_ATTEMPTS);
    snprintf(rows[3], sizeof rows[3], "OFF RETRY %lus %u/%u", (unsigned long)protection.secondsUntilReclose(now), next,
             (unsigned)Protection::MAX_RECLOSE_ATTEMPTS);
  } else if (uint32_t left = protection.secondsUntilTrip(now)) {
    snprintf(rows[3], sizeof rows[3], "TRIPPING IN %lus", (unsigned long)left);
  } else {
    snprintf(rows[3], sizeof rows[3], "T:%s/%dC  RLY:%s", num(a, sizeof a, reading.temperature, 1), (int)l.tempC,
             relay.closed() ? "ON" : "OFF");
  }
  lcd.show(rows);
}

void Controller::log(uint32_t now) {
  if (now - lastLog < LOG_INTERVAL_MS) return;
  lastLog = now;
  Serial.printf("V=%.1f A=%.3f VA=%.0f PF=%.2f T=%.1f %s relay=%s heap=%lu/%lu\n", reading.voltage, reading.current,
                reading.apparentPower(), reading.powerFactor, reading.temperature, Protection::label(protection.state()),
                relay.closed() ? "CLOSED" : "OPEN", (unsigned long)ESP.getFreeHeap(),
                (unsigned long)ESP.getMaxAllocHeap());
}
