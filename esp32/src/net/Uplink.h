#pragma once

#include "../core/Controller.h"
#include "Backend.h"
#include "LiveServer.h"
#include "Wifi.h"

class Uplink {
 public:
  explicit Uplink(Controller &controller) : controller(controller), live(controller) {}

  void begin();
  void loop();

 private:
  void handle(const Backend::Reply &reply, const Snapshot &snapshot, bool heartbeat);

  Controller &controller;
  Wifi wifi;
  Backend backend;
  LiveServer live;

  bool wasOnline = false;
  bool heartbeatDue = true;
  uint32_t lastPost = 0;
  uint32_t lastHeartbeat = 0;
  uint32_t lastAnswer = 0;
  uint32_t postedChanges = 0;
};
