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

  /// Whether the load is currently disconnected, so the caller can persist it.
  bool isTripped() const { return status == STATUS_OVERLOAD; }

  /// Restores a trip that survived a reboot.
  ///
  /// A fault is exactly when supply quality is worst, so browning out mid-trip is
  /// realistic. Without this the board would come back believing everything is NORMAL
  /// and close straight into the fault it had just disconnected. The lockout restarts
  /// from now rather than resuming, which is the conservative direction: it waits the
  /// full window again instead of assuming time served.
  void restoreTrip(unsigned long now, bool wasLockedOut = false);

  /// True once per crossing into the alarm level, and cleared by reading it.
  ///
  /// Edge rather than level: the caller uses it to post immediately, and a level would
  /// have it posting on every pass for as long as the load stayed up.
  bool takeAlarmEdge();

  /// The current status, spelled the same way the serial log and the backend spell it.
  const char *statusLabel() { return statusName(); }

  /// Open, out of attempts, and waiting for a person.
  bool isLockedOut() const { return lockedOut; }

  /// Reclose attempts spent on the current run, for the display and the backend.
  uint8_t recloseAttempts() const { return attempts; }

  /// Closes the contacts because a person asked, clearing any lockout on the way.
  ///
  /// The only way out of a lockout, and deliberately not something the board can decide
  /// for itself: it locked out precisely because it cannot tell whether the fault is
  /// still there. Somebody has to go and look.
  ///
  /// Closes directly rather than handing the job to the recloser. The recloser will not
  /// act until `belowClear()`, and that question cannot be answered while the contacts
  /// are open: no current flows, so the meter reads zero whether the fault was fixed or
  /// nothing was touched, and it reads NAN whenever the meter itself is unreachable.
  /// Routed through there, an operator's close did nothing at all on a board whose PZEM
  /// was not reporting, with no lit button and no message to say why.
  ///
  /// Safe because closing is not the same as staying closed. The next sample is a
  /// second away, and a genuine fault re-trips within TRIP_CONFIRM_MS and sets the
  /// retry wait, so a close into a live overload energizes for about four seconds and
  /// then opens itself. That is the intended answer to "let me try": find out by
  /// looking, under protection, rather than refuse on a measurement that cannot mean
  /// anything yet.
  void closeByOperator(unsigned long now);

  /// True while an operator's close request would be refused.
  bool manualHeld(unsigned long now) const {
    return manualBlockedUntil != 0 && (long)(now - manualBlockedUntil) < 0;
  }

  /// Opens the contacts because a person asked, and holds them open.
  ///
  /// Locked out rather than merely tripped, and with the attempts spent, so the recloser
  /// cannot undo it thirty seconds later. An operator opening the relay is doing it to
  /// work on something; a board that closed itself again while they had their hands in
  /// the panel would be the worst failure this system could have. Only another explicit
  /// close gets out of it, which is the same door the lockout uses.
  void openByOperator(unsigned long now);

  /// Adopts the reclose delay an operator set in the app.
  ///
  /// Bounded here as well as in the app and the API, because this is the copy that
  /// actually energises a fault: a zero would close straight back into it with no wait
  /// at all. The range matches the database check constraint.
  ///
  /// Reports whether it was taken, so the caller knows whether a value is worth
  /// persisting. Writing a rejected one to NVS would make it the value that survives
  /// the next reboot, which is the opposite of what rejecting it was for.
  bool setRecloseDelay(unsigned long seconds);

  /// The live reclose wait in seconds, for persisting it and for the display.
  unsigned long recloseDelaySeconds() const { return recloseDelayMs / 1000UL; }

  /// Adopts how long the load must stay over the trip level before the contacts open.
  ///
  /// The other half of the pair, and the opposite of the one above: this wait runs
  /// while the load is still connected and decides whether to cut it.
  ///
  /// Reports whether it was taken, for the same reason the reclose setter does.
  bool setTripConfirm(unsigned long seconds);

  /// The live trip wait in seconds, for persisting it and for the display.
  unsigned long tripConfirmSeconds() const { return tripConfirmMs / 1000UL; }

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
  void setThresholds(float alarm, float trip, float temp);

  float loadThreshold() const { return vaLimit; }
  float tripThreshold() const { return tripLimit; }
  float tempThreshold() const { return tempLimit; }

 private:
  enum Status { STATUS_NORMAL, STATUS_WARNING, STATUS_OVERLOAD };

  static constexpr unsigned long SAMPLE_INTERVAL_MS = 1000;
  static constexpr unsigned long TRIP_CONFIRM_MS = 3000;

  /// Bounds on a trip wait handed over by a heartbeat, matching the database check.
  ///
  /// The floor is a second rather than none: a transformer draws several times its
  /// rated current for a fraction of a second at switch-on, and at zero the board would
  /// cut the load on that inrush every time it closed and never get past it.
  static constexpr unsigned long MIN_TRIP_CONFIRM_SECONDS = 1;
  static constexpr unsigned long MAX_TRIP_CONFIRM_SECONDS = 60;

  /// How long the contacts stay open before each reclose attempt.
  ///
  /// The same wait every time rather than a growing one. Backing off sounds prudent but
  /// stretches the run: a load that is genuinely too big would be re-energised over
  /// several minutes before the board gave up, and every one of those attempts is
  /// another inrush into a fault nobody has fixed. A fixed wait reaches the lockout
  /// quickly and leaves it there.
  static constexpr unsigned long RECLOSE_DELAY_MS = 30000;

  /// Bounds on a delay handed over by a heartbeat, matching the database constraint.
  static constexpr unsigned long MIN_RECLOSE_SECONDS = 5;
  static constexpr unsigned long MAX_RECLOSE_SECONDS = 600;

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

  bool sampleDue(unsigned long now);

  bool sample();

  /// Advisory level. Drives WARNING on the display and mirrors what the backend alerts
  /// on. Temperature is included here but deliberately not in the trip below.
  bool overAlarm();

  /// The level that opens the relay.
  ///
  /// Apparent power only. Temperature alarms but does not trip, because the operator
  /// threshold for it is an advisory number for a transformer, not a damage limit, and
  /// on a warm day here that would cut the load for no reason. A thermal trip belongs
  /// on its own much higher threshold, not on the one the dashboard warns at.
  bool overTrip();

  /// Whether it is safe to close again: the load is back at or under the alarm level.
  ///
  /// A missing measurement is NOT clear. This is the inverse of how it used to read,
  /// and the change matters: `isnan(apparentPower) || ...` meant that losing the meter
  /// while tripped counted as the fault clearing, so the board would have reclosed into
  /// a fault it could no longer see. Unknown holds the trip.
  bool belowClear();

  void updateStatus(unsigned long now);

  /// Drives the contacts from the status rather than switching them at the transitions.
  ///
  /// Deriving it every cycle makes the relay self-correcting: a state restored from NVS
  /// after a brownout, or any path that changes `status` without remembering to switch,
  /// still ends up with the contacts matching what the machine believes. Edge triggered
  /// calls are how a protection relay ends up closed while the display says OVERLOAD.
  void applyRelay();

  const char *statusName();

  /// Writes a measurement as a JSON number, or `null` when there isn't one.
  ///
  /// `String(NAN, 1)` renders the bare token `nan`, which no strict JSON parser
  /// accepts. NaN is the normal state whenever a sensor is missing, so left alone the
  /// line would stop parsing exactly when the log matters most.
  static void put(JsonDocument &doc, const char *key, float value, int digits);

  void publish(bool sensorsOk);

  void showLcd();

  /// What the relay is doing, in words, for somebody standing at the panel.
  ///
  /// Empty when there is nothing to say, which is what keeps the temperature row on
  /// screen during normal running. The states are deliberately the ones a person can
  /// act on: it is about to cut, it will try again in so many seconds, or it has given
  /// up and is waiting for them.
  String relayStatusLine() const;

  EnergyMeter &meter;
  TemperatureProbe &probe;
  Relay &relay;
  Lcd &lcd;

  /// Whether the meter answered the last exchange, so the change can be announced
  /// once instead of every second. Starts false: nothing has answered yet.
  bool meterAnswering = false;

  Status status = STATUS_NORMAL;
  bool alarmEdge = false;
  /// Attempts spent on the current run of trips, reset by a reclose that holds.
  uint8_t attempts = 0;
  /// When the contacts last closed after a trip, for judging whether it held.
  unsigned long closedAt = 0;
  /// Open and staying open. Survives a reboot, because a fault does.
  bool lockedOut = false;
  /// The live reclose wait, seeded from the compiled default until a heartbeat sets it.
  unsigned long recloseDelayMs = RECLOSE_DELAY_MS;
  /// The live trip wait, seeded from the compiled default until a heartbeat sets it.
  unsigned long tripConfirmMs = TRIP_CONFIRM_MS;
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
