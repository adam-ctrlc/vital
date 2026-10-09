#pragma once

#include <Arduino.h>
#include <WiFi.h>

// Never blocks. The driver reconnects by itself; this only restarts a radio that stays
// down, and rejoins a link that is "connected" but carries nothing.
class Wifi {
 public:
  void begin();

  void loop(uint32_t now, uint32_t lastAnswerAt);

  bool online() const { return WiFi.status() == WL_CONNECTED; }

 private:
  static void start();
  static void onDisconnected(arduino_event_id_t event, arduino_event_info_t info);

  bool wasOnline = false;
  uint32_t downSince = 0;
  uint32_t onlineSince = 0;
  uint32_t lastAction = 0;
};
