#pragma once

#include <Arduino.h>
#include <ArduinoJson.h>

#include "../hardware/EnergyMeter.h"
#include "../hardware/TemperatureProbe.h"
#include "../hardware/Relay.h"
#include "../hardware/Lcd.h"

class Monitor {
 public:
  Monitor(EnergyMeter &meter, TemperatureProbe &probe, Relay &relay, Lcd &lcd)
      : meter(meter), probe(probe), relay(relay), lcd(lcd) {}

  struct Snapshot {
    float voltage;
    float current;
    float power;
    float energy;
    float frequency;
    float powerFactor;
    float temperature;
  };

  void begin() {
    lcd.begin();
    relay.begin();
    meter.begin();
    probe.begin();
  }

  void loop(unsigned long now) {
    if (!sampleDue(now)) return;

    bool sensorsOk = sample();
    updateStatus(now);
    applyRelay();
    publish(sensorsOk);
    showLcd();
  }

  /// Whether the load is currently disconnected, so the caller can persist it.
  bool isTripped() const { return status == STATUS_OVERLOAD; }

  /// Restores a trip that survived a reboot.
  ///
  /// A fault is exactly when supply quality is worst, so browning out mid-trip is
  /// realistic. Without this the board would come back believing everything is NORMAL
  /// and close straight into the fault it had just disconnected. The lockout restarts
  /// from now rather than resuming, which is the conservative direction: it waits the
  /// full window again instead of assuming time served.
  void restoreTrip(unsigned long now, bool wasLockedOut = false) {
    status = STATUS_OVERLOAD;
    trippedAt = now;
    // A lockout that did not survive the reboot would auto-close into the fault it was
    // holding open, which is the one outcome the lockout exists to prevent.
    lockedOut = wasLockedOut;
    attempts = wasLockedOut ? MAX_RECLOSE_ATTEMPTS : 0;
    applyRelay();
  }

  /// True once per crossing into the alarm level, and cleared by reading it.
  ///
  /// Edge rather than level: the caller uses it to post immediately, and a level would
  /// have it posting on every pass for as long as the load stayed up.
  bool takeAlarmEdge() {
    const bool crossed = alarmEdge;
    alarmEdge = false;

    return crossed;
  }

  /// The current status, spelled the same way the serial log and the backend spell it.
  const char *statusLabel() { return statusName(); }

  /// Open, out of attempts, and waiting for a person.
  bool isLockedOut() const { return lockedOut; }

  /// Reclose attempts spent on the current run, for the display and the backend.
  uint8_t recloseAttempts() const { return attempts; }

  /// Clears a lockout and lets the machine try again.
  ///
  /// The only way out of a lockout, and deliberately not something the board can decide
  /// for itself: it locked out precisely because it cannot tell whether the fault is
  /// still there. Somebody has to go and look.
  void resetLockout(unsigned long now) {
    if (!lockedOut && attempts == 0) return;

    // Refused, not queued. An operator whose close was undone a moment ago is asking
    // again before the board has finished deciding, and honouring that turns a
    // protection scheme into a switch that argues.
    if (manualBlockedUntil != 0 && (long)(now - manualBlockedUntil) < 0) {
      Serial.println("relay close refused, still within the retry wait");
      return;
    }

    Serial.println("relay lockout cleared by an operator");
    lockedOut = false;
    attempts = 0;
    closedAt = 0;
    manualClosedAt = now;
    // Backdated so the reclose is not made to wait out a fresh delay on top of however
    // long it has already been sitting open.
    trippedAt = now - RECLOSE_DELAY_MS;
  }

  /// True while an operator's close request would be refused.
  bool manualHeld(unsigned long now) const {
    return manualBlockedUntil != 0 && (long)(now - manualBlockedUntil) < 0;
  }

  /// The contacts are open and current is still flowing through them.
  ///
  /// Acted on by re-driving the output, then reported if it persists. A pin that never
  /// took the write is recoverable and worth retrying; a contact welded shut is not,
  /// and the only thing left for that one is to tell somebody.
  bool contactsStuck() const {
    return !relay.isClosed() && !isnan(current) && current >= STUCK_CONTACT_AMPS;
  }

  /// Whether the relay is passing load, for anything reporting the board's state.
  bool relayClosed() const { return relay.isClosed(); }

  Snapshot snapshot() const {
    return {voltage, current, power, energy, frequency, powerFactor, temperature};
  }

  // Adopts operator thresholds (from the heartbeat). The clear points keep the
  // defaults' hysteresis: ~6% below the load limit, 3 C below the temperature limit.
  /// Two load levels and one temperature level.
  ///
  /// `alarm` is advisory: it lights WARNING and is the level the backend raises an
  /// alert at, so somebody has a chance to shed load themselves. `trip` is what opens
  /// the relay when nobody did. Keeping them apart is the whole point; equal values
  /// would disconnect in the same instant the warning appeared.
  ///
  /// The relay recloses at the alarm level, so the two numbers define the deadband
  /// between them: trip at 980, close again at 900. The load has to come back to what
  /// the operator calls normal, not merely off the trip point, before it is restored.
  ///
  /// That also makes the deadband something you set rather than something derived from
  /// a hidden percentage, and the trip-above-alarm rule the API and Main both enforce
  /// is what guarantees it is never zero. Equal values would chatter the contacts.
  void setThresholds(float alarm, float trip, float temp) {
    vaLimit = alarm;
    tripLimit = trip;
    tempLimit = temp;
    tripClear = alarm;
    tempClear = temp > 3.0f ? temp - 3.0f : temp * 0.9f;
  }

  float loadThreshold() const { return vaLimit; }
  float tripThreshold() const { return tripLimit; }
  float tempThreshold() const { return tempLimit; }

 private:
  enum Status { STATUS_NORMAL, STATUS_WARNING, STATUS_OVERLOAD };

  static constexpr unsigned long SAMPLE_INTERVAL_MS = 1000;
  static constexpr unsigned long TRIP_CONFIRM_MS = 3000;

  /// How long the contacts stay open before each reclose attempt.
  ///
  /// The same wait every time rather than a growing one. Backing off sounds prudent but
  /// stretches the run: a load that is genuinely too big would be re-energised over
  /// several minutes before the board gave up, and every one of those attempts is
  /// another inrush into a fault nobody has fixed. A fixed wait reaches the lockout
  /// quickly and leaves it there.
  static constexpr unsigned long RECLOSE_DELAY_MS = 30000;

  /// Attempts before the board gives up and stays open.
  ///
  /// Opening the relay removes the current it is judging, so 0 VA means "nothing is
  /// flowing", not "the fault is gone". The only way to find out is to close and look,
  /// and the only way that is not an endless cycle is to bound how often it may ask.
  static constexpr uint8_t MAX_RECLOSE_ATTEMPTS = 3;

  /// How long an operator must wait before asking again after their close was undone.
  ///
  /// Short deliberately: this is not protection, it is a guard against a request being
  /// repeated faster than the board can act on it. The protection is that the overload
  /// re-opens the contacts regardless of who closed them.
  static constexpr unsigned long MANUAL_RETRY_MS = 3000;

  /// Current above this, with the contacts open, means they are not really open.
  ///
  /// A welded contact reads as a normal run: the load is still drawing, so nothing looks
  /// wrong except that the one thing meant to stop it did not.
  static constexpr float STUCK_CONTACT_AMPS = 0.15f;

  /// How long a reclose must survive before the run counts as recovered.
  ///
  /// Without it, unrelated trips hours apart would accumulate toward a lockout.
  static constexpr unsigned long RECLOSE_SURVIVED_MS = 60000;

  bool sampleDue(unsigned long now) {
    if (now - lastSample < SAMPLE_INTERVAL_MS) return false;
    lastSample = now;
    return true;
  }

  bool sample() {
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

  /// Advisory level. Drives WARNING on the display and mirrors what the backend alerts
  /// on. Temperature is included here but deliberately not in the trip below.
  bool overAlarm() {
    return (!isnan(apparentPower) && apparentPower >= vaLimit) ||
           (!isnan(temperature) && temperature >= tempLimit);
  }

  /// The level that opens the relay.
  ///
  /// Apparent power only. Temperature alarms but does not trip, because the operator
  /// threshold for it is an advisory number for a transformer, not a damage limit, and
  /// on a warm day here that would cut the load for no reason. A thermal trip belongs
  /// on its own much higher threshold, not on the one the dashboard warns at.
  bool overTrip() { return !isnan(apparentPower) && apparentPower >= tripLimit; }

  /// Whether it is safe to close again: the load is back at or under the alarm level.
  ///
  /// A missing measurement is NOT clear. This is the inverse of how it used to read,
  /// and the change matters: `isnan(apparentPower) || ...` meant that losing the meter
  /// while tripped counted as the fault clearing, so the board would have reclosed into
  /// a fault it could no longer see. Unknown holds the trip.
  bool belowClear() { return !isnan(apparentPower) && apparentPower <= tripClear; }

  void updateStatus(unsigned long now) {
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
          if (manualClosedAt != 0 && now - manualClosedAt <= RECLOSE_DELAY_MS) {
            Serial.println("overload after a manual close, opening again");
            manualBlockedUntil = now + MANUAL_RETRY_MS;
            manualClosedAt = 0;
          }
        }
        break;

      case STATUS_OVERLOAD:
        // Locked out is a decision, not a timer. Only a person clears it.
        if (lockedOut) break;

        if (belowClear() && now - trippedAt >= RECLOSE_DELAY_MS) {
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

  /// Drives the contacts from the status rather than switching them at the transitions.
  ///
  /// Deriving it every cycle makes the relay self-correcting: a state restored from NVS
  /// after a brownout, or any path that changes `status` without remembering to switch,
  /// still ends up with the contacts matching what the machine believes. Edge triggered
  /// calls are how a protection relay ends up closed while the display says OVERLOAD.
  void applyRelay() {
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

  const char *statusName() {
    switch (status) {
      case STATUS_OVERLOAD: return "OVERLOAD";
      case STATUS_WARNING: return "WARNING";
      default: return "NORMAL";
    }
  }

  /// Writes a measurement as a JSON number, or `null` when there isn't one.
  ///
  /// `String(NAN, 1)` renders the bare token `nan`, which no strict JSON parser
  /// accepts. NaN is the normal state whenever a sensor is missing, so left alone the
  /// line would stop parsing exactly when the log matters most.
  static void put(JsonDocument &doc, const char *key, float value, int digits) {
    if (isnan(value) || isinf(value)) {
      doc[key] = nullptr;
      return;
    }
    doc[key] = serialized(String(value, digits));
  }

  void publish(bool sensorsOk) {
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

  void showLcd() {
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

    lcd.show(header, measured, load, thermal);
  }

  EnergyMeter &meter;
  TemperatureProbe &probe;
  Relay &relay;
  Lcd &lcd;

  Status status = STATUS_NORMAL;
  bool alarmEdge = false;
  /// Attempts spent on the current run of trips, reset by a reclose that holds.
  uint8_t attempts = 0;
  /// When the contacts last closed after a trip, for judging whether it held.
  unsigned long closedAt = 0;
  /// Open and staying open. Survives a reboot, because a fault does.
  bool lockedOut = false;
  /// When an operator last closed it, for spotting a close the protection undid.
  unsigned long manualClosedAt = 0;
  /// Until when another close request is refused.
  unsigned long manualBlockedUntil = 0;
  unsigned long lastSample = 0;
  unsigned long abnormalSince = 0;
  unsigned long overTripSince = 0;
  unsigned long trippedAt = 0;

  // Compiled fallbacks for a board that has never heard from the backend. Sized for
  // the 1 KVA unit: alarm with room to shed load, trip close enough to the rating to
  // be a real backstop. NVS overrides these on the first heartbeat and keeps them.
  float vaLimit = 900.0f;
  float tripLimit = 980.0f;
  float tripClear = 900.0f;
  float tempLimit = 40.0f;
  float tempClear = 37.0f;

  float voltage = NAN;
  float current = NAN;
  float power = NAN;
  float energy = NAN;
  float frequency = NAN;
  float powerFactor = NAN;
  float apparentPower = NAN;
  float temperature = NAN;
};
