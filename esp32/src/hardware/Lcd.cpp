#include "Lcd.h"

Lcd::Lcd(uint8_t sda, uint8_t scl, uint8_t cols, uint8_t rows)
    : sdaPin(sda), sclPin(scl), cols(cols), rows(rows), present_(false), status_(-1) {}

void Lcd::begin() {
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

void Lcd::show(const String &line1, const String &line2, const String &line3,
               const String &line4) {
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

String Lcd::formatFloat(float value, int digits) {
  if (isnan(value)) return String("--");
  return String(value, digits);
}
