#pragma once

#include <Arduino.h>

#include "../config/Pins.h"
#include "../hardware/Lcd.h"

#define LCD_TEST_INTERVAL_MS 2000

class LcdTest {
 public:
  LcdTest();

  void begin();

  void loop();

 private:
  String statusText();

  Lcd lcd;
  unsigned long lastScreen = 0;
  int step = 0;
};
