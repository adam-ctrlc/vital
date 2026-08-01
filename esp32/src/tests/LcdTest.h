#pragma once

#include <Arduino.h>

#include "../config/Pins.h"
#include "../hardware/Lcd.h"

#define LCD_TEST_INTERVAL_MS 2000

class LcdTest {
 public:
  LcdTest() : lcd(LCD_SDA_PIN, LCD_SCL_PIN, LCD_COLS, LCD_ROWS) {}

  void begin() {
    Serial.begin(115200);
    delay(200);
    Serial.println();
    Serial.println("LCD test");
    Serial.println("Wiring: VCC to 5V, GND to GND, SDA to P13, SCL to P14.");
    Serial.println("hd44780 auto-detects the backpack I2C address and drives it.");

    lcd.begin();

    if (lcd.present()) {
      Serial.println("LCD detected on the bus.");
    } else {
      Serial.print("No LCD detected, hd44780 status ");
      Serial.println(lcd.status());
    }
  }

  void loop() {
    if (millis() - lastScreen < LCD_TEST_INTERVAL_MS) return;
    lastScreen = millis();

    switch (step) {
      case 0:
        lcd.show("LCD test", statusText(), "row 3", "row 4");
        break;
      case 1:
        // A ruler across all four rows: every column and every row should be filled
        // edge to edge. Anything blank means the configured geometry does not match
        // the panel, which is the failure this screen exists to catch.
        lcd.show("01234567890123456789", "--------------------", "01234567890123456789",
                 "--------------------");
        break;
      default:
        lcd.show("Uptime", String(millis() / 1000) + "s", "", "");
        break;
    }

    step = (step + 1) % 3;
  }

 private:
  String statusText() {
    if (lcd.present()) return String("detected");
    return "no LCD (" + String(lcd.status()) + ")";
  }

  Lcd lcd;
  unsigned long lastScreen = 0;
  int step = 0;
};
