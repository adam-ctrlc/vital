#pragma once

#include <ESPAsyncWebServer.h>

#include "../core/Controller.h"

// http://<board>/live, read by the app when it is on the same network.
class LiveServer {
 public:
  explicit LiveServer(Controller &controller) : controller(controller), server(80) {}

  void begin();

 private:
  Controller &controller;
  AsyncWebServer server;
};
