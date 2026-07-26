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
    publish(sensorsOk);
    showLcd();
  }

  Snapshot snapshot() const {
    return {voltage, current, power, energy, frequency, powerFactor, temperature};
  }

  // Adopts operator thresholds (from the heartbeat). The clear points keep the
  // defaults' hysteresis: ~6% below the load limit, 3 C below the temperature limit.
  void setThresholds(float va, float temp) {
    vaLimit = va;
    tempLimit = temp;
    vaClear = va * 0.94f;
    tempClear = temp > 3.0f ? temp - 3.0f : temp * 0.9f;
  }

  float loadThreshold() const { return vaLimit; }
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

  bool overLimit() {
    return (!isnan(apparentPower) && apparentPower >= vaLimit) ||
           (!isnan(temperature) && temperature >= tempLimit);
  }

  bool belowClear() {
    bool vaOk = isnan(apparentPower) || apparentPower <= vaClear;
    bool tempOk = isnan(temperature) || temperature <= tempClear;
    return vaOk && tempOk;
  }

  void updateStatus(unsigned long now) {
    switch (status) {
      case STATUS_NORMAL:
        if (overLimit()) {
          status = STATUS_WARNING;
          abnormalSince = now;
        }
        break;

      case STATUS_WARNING:
        if (!overLimit()) {
          status = STATUS_NORMAL;
          abnormalSince = 0;
        } else if (now - abnormalSince >= TRIP_CONFIRM_MS) {
          status = STATUS_OVERLOAD;
          trippedAt = now;
        }
        break;

      case STATUS_OVERLOAD:
        if (belowClear() && now - trippedAt >= RECLOSE_LOCKOUT_MS) {
          status = STATUS_NORMAL;
          abnormalSince = 0;
        }
        break;
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

    serializeJson(doc, Serial);
    Serial.println();
  }

  void showLcd() {
    // Line 2 shows the live status and the thresholds it is judged against, so a
    // change made in the app is visible on the board. Compact `load/tempC` keeps it
    // within 16 columns even at the longest status word, OVERLOAD.
    String line1 = "T:" + Lcd::formatFloat(temperature, 1) + "C VA:" + Lcd::formatFloat(apparentPower, 0);
    String line2 = String(statusName()) + " " + String((int)vaLimit) + "/" +
                   String((int)tempLimit) + "C";
    lcd.show(line1, line2);
  }

  EnergyMeter &meter;
  TemperatureProbe &probe;
  Relay &relay;
  Lcd &lcd;

  Status status = STATUS_NORMAL;
  unsigned long lastSample = 0;
  unsigned long abnormalSince = 0;
  unsigned long trippedAt = 0;

  float vaLimit = 900.0f;
  float vaClear = 850.0f;
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
