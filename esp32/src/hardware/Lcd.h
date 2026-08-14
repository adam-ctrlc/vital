#pragma once

#include <Arduino.h>
#include <Wire.h>
#include <hd44780.h>
#include <hd44780ioClass/hd44780_I2Cexp.h>

class Lcd {
 public:
  Lcd(uint8_t sda, uint8_t scl, uint8_t cols, uint8_t rows);

  /// Brings up the PCF8574 backpack over the custom I2C pins. hd44780 auto-detects
  /// the backpack address and register mapping, so begin() just starts the bus on the
  /// chosen pins and reports the driver status. A nonzero status (no device, or begin
  /// failed) leaves present() false and keeps every show() a safe no-op with no LCD
  /// wired.
  void begin();

  bool present() const { return present_; }
  int status() const { return status_; }

  /// Callers that lay out a line need the width, and taking it from here rather than
  /// the LCD_COLS macro keeps them from depending on Pins.h being included first.
  uint8_t width() const { return cols; }

  /// Overwrites every row in place, padding each to cols with spaces instead of
  /// clearing, to keep the display from flickering between updates.
  ///
  /// The last two lines are optional, so the callers with only two things to say
  /// (the Wi-Fi states, the test screens) stay unchanged. Rows they omit are blanked
  /// rather than left showing whatever the previous screen put there.
  void show(const String &line1, const String &line2, const String &line3 = String(),
            const String &line4 = String());

  static String formatFloat(float value, int digits);

 private:
  /// Ceiling on the rows show() can address. Four covers every HD44780 geometry the
  /// hd44780 library drives, and bounds the pointer array in show().
  static constexpr uint8_t MAX_ROWS = 4;

  uint8_t sdaPin;
  uint8_t sclPin;
  uint8_t cols;
  uint8_t rows;
  bool present_;
  int status_;
  hd44780_I2Cexp lcd;
};
