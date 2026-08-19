// Relay bench test. Standalone on purpose: nothing here is shared with the firmware,
// so when the contacts do not move this narrows it to the relay, its pin and its
// supply, with no other code able to be the reason.
//
// Flips every 5 seconds and reports on the 20x4 I2C LCD and on serial at 115200.
//
// Wiring, the same pins the firmware uses:
//   relay IN  -> P18       LCD SDA -> P13
//   relay VCC -> 5V       9 LCD SCL -> P14
//   relay GND -> GND       LCD VCC -> 5V, GND -> GND
//
// The module is active low, so closing the contacts drives P18 LOW. Row 2 shows the
// level and the meaning together: on an active low board they read as opposites, and
// seeing them agree is the sign the wiring or the polarity is inverted.

#include <Arduino.h>
#include <Wire.h>
#include <hd44780.h>
#include <hd44780ioClass/hd44780_I2Cexp.h>

#define RELAY_PIN 18
#define RELAY_ON LOW
#define RELAY_OFF HIGH

#define LCD_SDA_PIN 13
#define LCD_SCL_PIN 14
#define LCD_COLS 20
#define LCD_ROWS 4

#define FLIP_INTERVAL_MS 5000

hd44780_I2Cexp lcd;

bool lcdPresent = false;
bool closed = false;
unsigned long lastFlip = 0;
unsigned long lastDraw = 0;
uint32_t cycles = 0;

// Pads each row to the full width instead of clearing, so the display does not flicker
// between updates, and truncates anything that would overrun.
void row(uint8_t line, const String &text) {
  if (!lcdPresent) return;

  String out = text;
  if (out.length() > LCD_COLS) out = out.substring(0, LCD_COLS);
  out.reserve(LCD_COLS);
  while (out.length() < LCD_COLS) out += ' ';

  lcd.setCursor(0, line);
  lcd.print(out);
}

void draw() {
  lastDraw = millis();

  String header = "RELAY TEST";
  const String state = closed ? "ON" : "OFF";
  while (header.length() + state.length() < LCD_COLS) header += ' ';
  header += state;

  const unsigned long elapsed = millis() - lastFlip;
  const unsigned long left =
      elapsed >= FLIP_INTERVAL_MS ? 0 : (FLIP_INTERVAL_MS - elapsed + 999) / 1000UL;

  row(0, header);
  row(1, closed ? "P18: LOW  energized" : "P18: HIGH open");
  row(2, "Flips in " + String(left) + "s");
  row(3, "Cycles: " + String(cycles));
}

void apply() {
  digitalWrite(RELAY_PIN, closed ? RELAY_ON : RELAY_OFF);

  Serial.print("relay ");
  Serial.print(closed ? "CLOSED" : "OPEN  ");
  Serial.print("  P18 driven ");
  Serial.print(closed ? "LOW " : "HIGH");
  Serial.print("  cycles ");
  Serial.println(cycles);
}

void setup() {
  Serial.begin(115200);
  delay(200);
  Serial.println();
  Serial.println("Relay bench test");
  Serial.println("Active low: closing the contacts drives P18 LOW.");
  Serial.println("Flipping every 5 seconds. Nothing else is running.");

  Wire.begin(LCD_SDA_PIN, LCD_SCL_PIN);
  const int status = lcd.begin(LCD_COLS, LCD_ROWS);
  lcdPresent = (status == 0);
  if (lcdPresent) {
    lcd.backlight();
    Serial.println("LCD detected.");
  } else {
    Serial.print("No LCD, hd44780 status ");
    Serial.println(status);
    Serial.println("The test still runs; watch serial instead.");
  }

  // Driven open before anything else, the same way the firmware comes up, so the load
  // starts de-energized and the first flip is into ON.
  pinMode(RELAY_PIN, OUTPUT);
  apply();

  lastFlip = millis();
  draw();
}

void loop() {
  const unsigned long now = millis();

  if (now - lastFlip >= FLIP_INTERVAL_MS) {
    lastFlip = now;
    closed = !closed;
    // Counted on the closing edge, so one number is one full off-on-off round.
    if (closed) cycles++;
    apply();
    draw();
  }

  // The countdown only changes once a second, and the LCD is slow enough that redrawing
  // every pass makes the digits flicker.
  if (now - lastDraw >= 1000) draw();
}
