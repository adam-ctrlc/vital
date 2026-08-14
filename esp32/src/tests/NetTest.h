#pragma once

#include <Arduino.h>
#include <OneWire.h>
#include <DallasTemperature.h>

#include "../config/Pins.h"
#include "../hardware/Lcd.h"
#include "../net/BackendClient.h"
#include "../net/WifiLink.h"

#define POST_INTERVAL_MS 10000
#define HEARTBEAT_INTERVAL_MS 30000

class NetTest {
 public:
  NetTest();

  void begin();

  void loop();

 private:
  Lcd lcd;
  BackendClient backend;
  WifiLink net;
  OneWire oneWire;
  DallasTemperature sensors;
  unsigned long lastPost = 0;
  unsigned long lastHeartbeat = 0;
};
