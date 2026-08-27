#pragma once

#include <Arduino.h>
#include <Wire.h>
#include <hd44780.h>
#include <hd44780ioClass/hd44780_I2Cexp.h>

class Lcd {
 public:
  Lcd(uint8_t sda, uint8_t scl, uint8_t cols, uint8_t rows);

  /// Brings up the PCF8574 backpack on the custom I2C pins. hd44780 auto-detects the
  /// address and register mapping, so this just starts the bus. A nonzero status leaves
  /// present() false, which makes every show() a safe no-op with no LCD wired.
  void begin();

  bool present() const { return present_; }
  int status() const { return status_; }

  /// Taken from here rather than the LCD_COLS macro, so callers laying out a line do
  /// not depend on Pins.h being included first.
  uint8_t width() const { return cols; }

  /// Overwrites every row in place, padding to cols with spaces instead of clearing, so
  /// the display does not flicker between updates. The last two lines are optional and
  /// blanked when omitted, for the callers with only two things to say.
  void show(const String &line1, const String &line2, const String &line3 = String(),
            const String &line4 = String());

  static String formatFloat(float value, int digits);

 private:
  /// Ceiling on the rows show() can address, and the bound on its pointer array. Four
  /// covers every HD44780 geometry the library drives.
  static constexpr uint8_t MAX_ROWS = 4;

  uint8_t sdaPin;
  uint8_t sclPin;
  uint8_t cols;
  uint8_t rows;
  bool present_;
  int status_;
  hd44780_I2Cexp lcd;
};
