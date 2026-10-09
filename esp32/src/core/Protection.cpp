#include "Protection.h"

#include <cmath>

// Same bounds as the database. A 0 s trip delay would trip on switch-on inrush.
static constexpr float MIN_VA = 1.0f, MAX_VA = 2000.0f;
static constexpr float MIN_TEMP_C = 1.0f, MAX_TEMP_C = 150.0f;
static constexpr uint32_t MIN_TRIP_S = 1, MAX_TRIP_S = 60;
static constexpr uint32_t MIN_RECLOSE_S = 5, MAX_RECLOSE_S = 600;

static bool within(float value, float low, float high) {
  return !std::isnan(value) && value >= low && value <= high;
}

bool Protection::setLimits(const Limits &limits) {
  if (!within(limits.alarmVa, MIN_VA, MAX_VA) || !within(limits.tripVa, MIN_VA, MAX_VA) ||
      limits.tripVa <= limits.alarmVa || !within(limits.tempC, MIN_TEMP_C, MAX_TEMP_C)) {
    return false;
  }
  limits_ = limits;
  return true;
}

bool Protection::setTripDelaySeconds(uint32_t seconds) {
  if (seconds < MIN_TRIP_S || seconds > MAX_TRIP_S) return false;
  tripDelayMs_ = seconds * 1000;
  return true;
}

bool Protection::setRecloseDelaySeconds(uint32_t seconds) {
  if (seconds < MIN_RECLOSE_S || seconds > MAX_RECLOSE_S) return false;
  recloseDelayMs_ = seconds * 1000;
  return true;
}

void Protection::restore(bool tripped, bool lockedOut, uint32_t now) {
  if (!tripped) return;
  state_ = State::Tripped;
  trippedAt_ = now;
  lockedOut_ = lockedOut;
  attempts_ = lockedOut ? MAX_RECLOSE_ATTEMPTS : 0;
}

void Protection::holdOpenUntil(uint32_t until) {
  holding_ = true;
  holdUntil_ = until;
}

void Protection::update(float va, float amps, float tempC, uint32_t now) {
  if (!std::isnan(amps) && amps >= instantTripAmps_ && state_ != State::Tripped) {
    trip(now);
    lockedOut_ = true;
    attempts_ = MAX_RECLOSE_ATTEMPTS;
    instantTripped_ = true;
    return;
  }

  const bool haveVa = !std::isnan(va);
  const bool overTrip = (haveVa && va >= limits_.tripVa) || (!std::isnan(amps) && amps >= currentTripAmps_);
  const bool overAlarm =
      overTrip || (haveVa && va >= limits_.alarmVa) || (!std::isnan(tempC) && tempC >= limits_.tempC);

  if (watchingReclose_ && state_ != State::Tripped && now - reclosedAt_ >= RECLOSE_SURVIVED_MS) {
    watchingReclose_ = false;
    attempts_ = 0;
  }

  switch (state_) {
    case State::Normal:
      if (!overAlarm) break;
      state_ = State::Warning;
      alarmEdge_ = true;
      timingTrip_ = overTrip;
      overTripSince_ = now;
      break;

    case State::Warning:
      if (!overAlarm) {
        state_ = State::Normal;
        timingTrip_ = false;
        break;
      }
      if (!overTrip) {
        timingTrip_ = false;
        break;
      }
      if (!timingTrip_) {
        timingTrip_ = true;
        overTripSince_ = now;
      }
      if (now - overTripSince_ >= tripDelayMs_) trip(now);
      break;

    case State::Tripped:
      // A missing reading is not "clear".
      if (lockedOut_ || !haveVa || va > limits_.alarmVa || now - trippedAt_ < recloseDelayMs_) break;
      if (attempts_ >= MAX_RECLOSE_ATTEMPTS) {
        lockedOut_ = true;
        break;
      }
      attempts_++;
      state_ = State::Normal;
      watchingReclose_ = true;
      reclosedAt_ = now;
      break;
  }
}

void Protection::trip(uint32_t now) {
  state_ = State::Tripped;
  trippedAt_ = now;
  timingTrip_ = false;
  if (manualClose_ && now - manualClosedAt_ <= recloseDelayMs_) {
    manualBlocked_ = true;
    manualBlockedUntil_ = now + MANUAL_RETRY_MS;
  }
  manualClose_ = false;
}

bool Protection::operatorClose(uint32_t now) {
  if (state_ != State::Tripped) return false;
  if (manualBlocked_ && !reached(now, manualBlockedUntil_)) return false;
  manualBlocked_ = false;
  lockedOut_ = false;
  instantTripped_ = false;
  attempts_ = 0;
  watchingReclose_ = false;
  manualClose_ = true;
  manualClosedAt_ = now;
  state_ = State::Normal;
  timingTrip_ = false;
  return true;
}

void Protection::operatorOpen(uint32_t now) {
  if (state_ == State::Tripped && lockedOut_) return;
  state_ = State::Tripped;
  trippedAt_ = now;
  lockedOut_ = true;
  attempts_ = MAX_RECLOSE_ATTEMPTS;
  timingTrip_ = false;
  watchingReclose_ = false;
  manualClose_ = false;
}

bool Protection::shouldClose(uint32_t now) const {
  return state_ != State::Tripped && (!holding_ || reached(now, holdUntil_));
}

bool Protection::takeAlarmEdge() {
  const bool edge = alarmEdge_;
  alarmEdge_ = false;
  return edge;
}

static uint32_t secondsLeft(uint32_t elapsed, uint32_t total) {
  return elapsed >= total ? 0 : (total - elapsed + 999) / 1000;
}

uint32_t Protection::secondsUntilTrip(uint32_t now) const {
  return state_ == State::Warning && timingTrip_ ? secondsLeft(now - overTripSince_, tripDelayMs_) : 0;
}

uint32_t Protection::secondsUntilReclose(uint32_t now) const {
  return state_ == State::Tripped && !lockedOut_ ? secondsLeft(now - trippedAt_, recloseDelayMs_) : 0;
}

uint32_t Protection::secondsHeldOpen(uint32_t now) const {
  return holding_ && !reached(now, holdUntil_) ? (holdUntil_ - now + 999) / 1000 : 0;
}

const char *Protection::label(State state) {
  switch (state) {
    case State::Warning: return "WARNING";
    case State::Tripped: return "OVERLOAD";
    default: return "NORMAL";
  }
}
