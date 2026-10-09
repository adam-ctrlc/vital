#pragma once

#include <Arduino.h>

#include <atomic>

#include "../hardware/Lcd.h"
#include "../hardware/Relay.h"
#include "../hardware/Sensors.h"
#include "Protection.h"
#include "Settings.h"

struct Snapshot {
  Reading reading;
  Protection::State state = Protection::State::Normal;
  bool relayClosed = false;
  bool lockedOut = false;
  Protection::Limits limits;
  uint32_t tripDelaySeconds = 0;
  uint32_t recloseDelaySeconds = 0;
  // bumped on alarm crossings and relay moves
  uint32_t changes = 0;
};

struct Command {
  enum Kind : uint8_t { Open, Close, SetLimits, SetTripDelay, SetRecloseDelay };
  Kind kind;
  Protection::Limits limits = {};
  uint32_t seconds = 0;
};

// Runs the protection on its own task, so a slow network call can never delay a trip.
// Owns the sensors, relay, LCD and flash; the network side gets snapshots and sends commands.
class Controller {
 public:
  void begin();

  Snapshot snapshot() const;
  void send(const Command &command);
  void setOnline(bool online) { online_ = online; }

 private:
  static void taskEntry(void *self);
  void run();
  void sample(uint32_t now);
  void apply(const Command &command, uint32_t now);
  void driveRelay(uint32_t now);
  void persist(uint32_t now);
  void publish();
  void show(uint32_t now);
  void log(uint32_t now);

  Sensors sensors;
  Relay relay;
  Lcd lcd;
  Settings settings;
  Protection protection;
  Reading reading;

  QueueHandle_t commands = nullptr;
  mutable portMUX_TYPE lock = portMUX_INITIALIZER_UNLOCKED;
  Snapshot shared;
  std::atomic<bool> online_{false};

  uint32_t changes = 0;
  bool savedTripped = false;
  bool savedLockedOut = false;
  uint32_t persistAt = 0;
  bool stable = false;
  uint32_t lastLog = 0;
  uint32_t lastStuckWarning = 0;
};
