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

  void begin();

  void loop(unsigned long now);

  bool isTripped() const { return status == STATUS_OVERLOAD; }

  /// Restores a trip that survived a reboot, so the board does not come back believing
  /// everything is fine and close straight into the fault. The lockout wait restarts
  /// from now rather than resuming.
  void restoreTrip(unsigned long now, bool wasLockedOut = false);

  /// True once per crossing into the alarm level, cleared by reading it. Edge rather
  /// than level, so the caller posts once instead of on every pass.
  bool takeAlarmEdge();

  /// The status, spelled the way the serial log and the backend spell it.
  const char *statusLabel() { return statusName(); }

  /// Open, out of attempts, and waiting for a person.
  bool isLockedOut() const { return lockedOut; }

  uint8_t recloseAttempts() const { return attempts; }

  /// Closes the contacts on an operator's request, clearing any lockout. The only way
  /// out of a lockout, because the board cannot tell whether the fault is still there.
  ///
  /// Closes directly instead of asking the recloser, which will not act until
  /// belowClear() and that cannot be answered with the contacts open. Safe because a
  /// genuine fault re-trips within the confirm wait a few seconds later.
  void closeByOperator(unsigned long now);

  /// True while an operator's close request would be refused.
  bool manualHeld(unsigned long now) const {
    return manualBlockedUntil != 0 && (long)(now - manualBlockedUntil) < 0;
  }

  /// Opens the contacts on an operator's request and holds them open. Locks out with
  /// the attempts spent, so the recloser cannot re-energize the panel somebody is
  /// working on. Only another explicit close gets out of it.
  void openByOperator(unsigned long now);

  /// Adopts the reclose delay an operator set in the app. Bounded here too, since this
  /// is the copy that re-energizes a fault. Reports whether it was taken, so a rejected
  /// value is never persisted.
  bool setRecloseDelay(unsigned long seconds);

  unsigned long recloseDelaySeconds() const { return recloseDelayMs / 1000UL; }

  /// How long the load must stay over the trip level before the contacts open. The
  /// opposite of the wait above: this one runs while the load is still connected.
  bool setTripConfirm(unsigned long seconds);

  unsigned long tripConfirmSeconds() const { return tripConfirmMs / 1000UL; }

  /// Contacts open and current still flowing, so they are not really open. Retried by
  /// re-driving the pin, then reported if it persists: that means welded.
  bool contactsStuck() const {
    return !relay.isClosed() && !isnan(current) && current >= STUCK_CONTACT_AMPS;
  }

  bool relayClosed() const { return relay.isClosed(); }

  Snapshot snapshot() const {
    return {voltage, current, power, energy, frequency, powerFactor, temperature};
  }

  /// Two load levels and one temperature level.
  ///
  /// `alarm` is advisory: it lights WARNING and is what the backend alerts on, giving
  /// somebody a chance to shed load. `trip` opens the relay when nobody did. The relay
  /// recloses at the alarm level, so the gap between the two is the deadband: trip at
  /// 980, close again at 900. Equal values would chatter the contacts, which is why
  /// both the API and Main require trip above alarm.
  void setThresholds(float alarm, float trip, float temp);

  float loadThreshold() const { return vaLimit; }
  float tripThreshold() const { return tripLimit; }
  float tempThreshold() const { return tempLimit; }

 private:
  enum Status { STATUS_NORMAL, STATUS_WARNING, STATUS_OVERLOAD };

  static constexpr unsigned long SAMPLE_INTERVAL_MS = 1000;
  static constexpr unsigned long TRIP_CONFIRM_MS = 3000;

  /// Bounds on a trip wait from a heartbeat, matching the database check. The floor is
  /// a second rather than none, because a transformer's switch-on inrush would trip a
  /// zero wait every time and the board would never get past it.
  static constexpr unsigned long MIN_TRIP_CONFIRM_SECONDS = 1;
  static constexpr unsigned long MAX_TRIP_CONFIRM_SECONDS = 60;

  /// How long the contacts stay open before each reclose attempt. Fixed rather than
  /// backing off: a growing wait re-energizes a genuine overload over several minutes
  /// before giving up, and every attempt is another inrush into an unfixed fault.
  static constexpr unsigned long RECLOSE_DELAY_MS = 30000;

  /// Bounds on a delay from a heartbeat, matching the database constraint.
  static constexpr unsigned long MIN_RECLOSE_SECONDS = 5;
  static constexpr unsigned long MAX_RECLOSE_SECONDS = 600;

  /// Attempts before the board gives up and stays open. Opening removes the current it
  /// is judging, so the only way to know whether the fault cleared is to close and look,
  /// and that has to be bounded.
  static constexpr uint8_t MAX_RECLOSE_ATTEMPTS = 3;

  /// How long an operator waits before asking again after their close was undone. Not
  /// protection, just a guard against asking faster than the board can act.
  static constexpr unsigned long MANUAL_RETRY_MS = 3000;

  /// Current above this with the contacts open means they are welded. It otherwise
  /// reads as a perfectly normal run.
  static constexpr float STUCK_CONTACT_AMPS = 0.15f;

  /// How long a reclose must survive to count as recovered. Without it, unrelated trips
  /// hours apart would accumulate toward a lockout.
  static constexpr unsigned long RECLOSE_SURVIVED_MS = 60000;

  bool sampleDue(unsigned long now);

  bool sample();

  /// Advisory level: lights WARNING and mirrors what the backend alerts on. Includes
  /// temperature, which the trip below deliberately does not.
  bool overAlarm();

  /// The level that opens the relay. Apparent power only, because the temperature
  /// threshold is an advisory number for a transformer, not a damage limit, and on a
  /// warm day it would cut the load for no reason.
  bool overTrip();

  /// Safe to close again: the load is back at or under the alarm level. A missing
  /// measurement is NOT clear, or losing the meter while tripped would read as the
  /// fault clearing.
  bool belowClear();

  void updateStatus(unsigned long now);

  /// Derives the contacts from the status every cycle instead of switching them at the
  /// transitions, so the relay is self-correcting. Edge triggered calls are how a
  /// protection relay ends up closed while the display says OVERLOAD.
  void applyRelay();

  const char *statusName();

  /// Writes a measurement as a JSON number, or `null` when there isn't one. String(NAN)
  /// renders a bare `nan`, which no strict parser accepts.
  static void put(JsonDocument &doc, const char *key, float value, int digits);

  void publish(bool sensorsOk);

  void showLcd();

  /// What the relay is doing, in words, for somebody standing at the panel. Empty when
  /// there is nothing to say, which keeps the temperature row on screen.
  String relayStatusLine() const;

  EnergyMeter &meter;
  TemperatureProbe &probe;
  Relay &relay;
  Lcd &lcd;

  /// Whether the meter answered last time, so the change is announced once rather than
  /// every second.
  bool meterAnswering = false;

  Status status = STATUS_NORMAL;
  bool alarmEdge = false;
  /// Attempts spent on the current run of trips, reset by a reclose that holds.
  uint8_t attempts = 0;
  /// When the contacts last closed after a trip, for judging whether it held.
  unsigned long closedAt = 0;
  /// Open and staying open. Survives a reboot, because a fault does.
  bool lockedOut = false;
  /// Live waits, seeded from the compiled defaults until a heartbeat sets them.
  unsigned long recloseDelayMs = RECLOSE_DELAY_MS;
  unsigned long tripConfirmMs = TRIP_CONFIRM_MS;
  /// When an operator last closed it, for spotting a close the protection undid.
  unsigned long manualClosedAt = 0;
  /// Until when another close request is refused.
  unsigned long manualBlockedUntil = 0;
  unsigned long lastSample = 0;
  unsigned long abnormalSince = 0;
  unsigned long overTripSince = 0;
  unsigned long trippedAt = 0;

  // Fallbacks for a board that has never heard from the backend, sized for the 1 KVA
  // unit. NVS overrides these on the first heartbeat.
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
