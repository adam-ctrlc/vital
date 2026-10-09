#pragma once

#include <cstdint>

// Overload protection as pure logic (no Arduino calls), tested in tests/protection.
// alarm: warning only. trip: opens the relay after the trip delay, recloses after the
// reclose delay once load <= alarm, locks out after 3 tries. temp: warning only.
// current trip: like trip, but on amps. instant: at or above this current it opens at once and locks out.
class Protection {
 public:
  enum class State : uint8_t { Normal, Warning, Tripped };

  struct Limits {
    float alarmVa = 900.0f;
    float tripVa = 980.0f;
    float tempC = 40.0f;
  };

  static constexpr uint8_t MAX_RECLOSE_ATTEMPTS = 3;
  static constexpr uint32_t RECLOSE_SURVIVED_MS = 60000;
  static constexpr uint32_t MANUAL_RETRY_MS = 3000;

  // false = out of range, nothing changed
  bool setLimits(const Limits &limits);
  bool setTripDelaySeconds(uint32_t seconds);
  bool setRecloseDelaySeconds(uint32_t seconds);
  void setCurrentTripAmps(float amps) { currentTripAmps_ = amps; }
  void setInstantTripAmps(float amps) { instantTripAmps_ = amps; }

  void restore(bool tripped, bool lockedOut, uint32_t now);
  void holdOpenUntil(uint32_t until);

  void update(float va, float amps, float tempC, uint32_t now);

  bool operatorClose(uint32_t now);
  void operatorOpen(uint32_t now);

  bool shouldClose(uint32_t now) const;
  bool takeAlarmEdge();

  State state() const { return state_; }
  bool tripped() const { return state_ == State::Tripped; }
  bool lockedOut() const { return lockedOut_; }
  bool instantTripped() const { return instantTripped_; }
  uint8_t attempts() const { return attempts_; }
  const Limits &limits() const { return limits_; }
  uint32_t tripDelaySeconds() const { return tripDelayMs_ / 1000; }
  uint32_t recloseDelaySeconds() const { return recloseDelayMs_ / 1000; }

  uint32_t secondsUntilTrip(uint32_t now) const;
  uint32_t secondsUntilReclose(uint32_t now) const;
  uint32_t secondsHeldOpen(uint32_t now) const;

  static const char *label(State state);

 private:
  static bool reached(uint32_t now, uint32_t at) { return (int32_t)(now - at) >= 0; }
  void trip(uint32_t now);

  Limits limits_;
  uint32_t tripDelayMs_ = 2000;
  float currentTripAmps_ = 9.09f;
  float instantTripAmps_ = 90.91f;
  uint32_t recloseDelayMs_ = 30000;

  State state_ = State::Normal;
  bool lockedOut_ = false;
  bool instantTripped_ = false;
  bool alarmEdge_ = false;
  uint8_t attempts_ = 0;

  bool timingTrip_ = false;
  uint32_t overTripSince_ = 0;
  uint32_t trippedAt_ = 0;
  bool watchingReclose_ = false;
  uint32_t reclosedAt_ = 0;
  bool manualClose_ = false;
  uint32_t manualClosedAt_ = 0;
  bool manualBlocked_ = false;
  uint32_t manualBlockedUntil_ = 0;
  bool holding_ = false;
  uint32_t holdUntil_ = 0;
};
