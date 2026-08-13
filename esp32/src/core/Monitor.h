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
  void restoreTrip(unsigned long now) {
    status = STATUS_OVERLOAD;
    trippedAt = now;
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
  static constexpr unsigned long RECLOSE_LOCKOUT_MS = 30000;

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
        }
        break;

      case STATUS_OVERLOAD:
        if (belowClear() && now - trippedAt >= RECLOSE_LOCKOUT_MS) {
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
    if (relay.isClosed() != shouldClose) relay.set(shouldClose);
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
