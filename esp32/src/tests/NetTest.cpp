#include "NetTest.h"

#include <WiFi.h>

NetTest::NetTest()
    : lcd(LCD_SDA_PIN, LCD_SCL_PIN, LCD_COLS, LCD_ROWS),
      backend(),
      net(lcd),
      oneWire(DS18B20_PIN),
      sensors(&oneWire) {}

void NetTest::begin() {
  Serial.begin(115200);
  delay(200);
  Serial.println();
  Serial.println("Backend connectivity test");

  pinMode(DS18B20_PIN, INPUT_PULLUP);
  sensors.begin();
  lcd.begin();
  net.begin();
  net.connect();
}

void NetTest::loop() {
  if (millis() - lastHeartbeat >= HEARTBEAT_INTERVAL_MS) {
    lastHeartbeat = millis();
    net.connect();
    // Never locked out: this harness has no relay and no state machine to lock.
    backend.postHeartbeat(false);
  }

  if (millis() - lastPost < POST_INTERVAL_MS) return;
  lastPost = millis();

  sensors.requestTemperatures();
  float t = sensors.getTempCByIndex(0);

  if (t == DEVICE_DISCONNECTED_C || t == 85.0f) {
    Serial.println("temperature read failed, skipping post.");
    return;
  }

  Serial.print("temperature: ");
  Serial.print(t, 2);
  Serial.println(" C");

  net.connect();
  // Temperature only, and the contacts reported closed because there are none here to
  // be open. Every other field is NAN, which the client drops from the payload.
  const bool ok = backend.postReading(NAN, NAN, t, NAN, NAN, NAN, NAN, true).ok;

  String line1 = "T: " + String(t, 2) + " C";
  String line2;
  if (WiFi.status() == WL_CONNECTED) {
    line2 = ok ? "Sent " + WiFi.localIP().toString() : String("Send failed");
  } else {
    line2 = "No WiFi";
  }
  lcd.show(line1, line2);
}
