#pragma once

#include <Arduino.h>
#include <Wire.h>
#include <hd44780.h>
#include <hd44780ioClass/hd44780_I2Cexp.h>

#include "../Config.h"

// Only the protection task may write to it: two tasks on one I2C bus corrupt each other.
class Lcd {
 public:
  void begin() {
    Wire.begin(LCD_SDA_PIN, LCD_SCL_PIN);
    present_ = lcd.begin(LCD_COLS, LCD_ROWS) == 0;
    if (present_) lcd.backlight();
    Serial.println(present_ ? "LCD found" : "no LCD");
  }

  // Pads instead of clearing, so nothing flickers.
  template <size_t N>
  void show(const char (&rows)[LCD_ROWS][N]) {
    if (!present_) return;
    char line[LCD_COLS + 1];
    for (uint8_t row = 0; row < LCD_ROWS; row++) {
      snprintf(line, sizeof line, "%-*.*s", LCD_COLS, LCD_COLS, rows[row]);
      lcd.setCursor(0, row);
      lcd.print(line);
    }
  }

 private:
  hd44780_I2Cexp lcd;
  bool present_ = false;
};
