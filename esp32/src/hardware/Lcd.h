#pragma once

#include <Arduino.h>
#include <Wire.h>
#include <hd44780.h>
#include <hd44780ioClass/hd44780_I2Cexp.h>

class Lcd {
 public:
  Lcd(uint8_t sda, uint8_t scl, uint8_t cols, uint8_t rows)
      : sdaPin(sda), sclPin(scl), cols(cols), rows(rows), present_(false), status_(-1) {}

  /// Brings up the PCF8574 backpack over the custom I2C pins. hd44780 auto-detects
  /// the backpack address and register mapping, so begin() just starts the bus on the
  /// chosen pins and reports the driver status. A nonzero status (no device, or begin
  /// failed) leaves present() false and keeps every show() a safe no-op with no LCD
  /// wired.
  void begin() {
    Wire.begin(sdaPin, sclPin);

    int status = lcd.begin(cols, rows);
    status_ = status;
    present_ = (status == 0);

    if (!present_) {
      Serial.print("LCD begin failed, hd44780 status ");
      Serial.println(status);
      return;
    }

    lcd.backlight();
    Serial.println("LCD detected (hd44780 I2C).");

    lcd.setCursor(0, 0);
    lcd.print("VITAL");
  }

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
            const String &line4 = String()) {
    if (!present_) return;

    const String *lines[MAX_ROWS] = {&line1, &line2, &line3, &line4};

    for (uint8_t row = 0; row < rows && row < MAX_ROWS; row++) {
      String text = *lines[row];
      if (text.length() > cols) text = text.substring(0, cols);

      // Reserved up front because the pad below appends one character at a time, and
      // an Arduino String reallocates as it grows. On a 20x4 that is 80 characters a
      // second at the sampling rate, and small repeated reallocations interleaved with
      // the tens of KB a TLS handshake takes is what fragments the heap on a board
      // with no PSRAM.
      text.reserve(cols);
      while (text.length() < cols) text += ' ';

      lcd.setCursor(0, row);
      lcd.print(text);
    }
  }

  static String formatFloat(float value, int digits) {
    if (isnan(value)) return String("--");
    return String(value, digits);
  }

 private:
  /// Ceiling on the rows show() can address. Four covers every HD44780 geometry the
  /// hd44780 library drives, and bounds the pointer array above.
  static constexpr uint8_t MAX_ROWS = 4;

  uint8_t sdaPin;
  uint8_t sclPin;
  uint8_t cols;
  uint8_t rows;
  bool present_;
  int status_;
  hd44780_I2Cexp lcd;
};
