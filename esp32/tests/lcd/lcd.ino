// Finds the I2C LCD and fills every cell, so a dead row or column shows.
#include <Wire.h>
#include <hd44780.h>
#include <hd44780ioClass/hd44780_I2Cexp.h>

#include "../../src/Config.h"

hd44780_I2Cexp lcd;

void setup() {
  Serial.begin(115200);
  Wire.begin(LCD_SDA_PIN, LCD_SCL_PIN);
  const int status = lcd.begin(LCD_COLS, LCD_ROWS);
  Serial.printf(status == 0 ? "LCD found\n" : "no LCD (hd44780 status %d): check SDA P13, SCL P14, 5V\n", status);
  if (status != 0) return;
  lcd.backlight();
  for (uint8_t row = 0; row < LCD_ROWS; row++) {
    lcd.setCursor(0, row);
    lcd.print("0123456789ABCDEFGHIJ");
  }
}

void loop() {}
