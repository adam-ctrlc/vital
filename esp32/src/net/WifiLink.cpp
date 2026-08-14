#include "WifiLink.h"

// Only the implementation needs the credentials, so they stop here rather than
// reaching everything that includes the header.
#include "../../secrets.h"

void WifiLink::begin() {
  WiFi.mode(WIFI_STA);
  WiFi.setAutoReconnect(true);
}

void WifiLink::connect() {
  if (WiFi.status() == WL_CONNECTED) return;

  WiFi.mode(WIFI_STA);
  lcd.show("WiFi connecting", WIFI_SSID);
  Serial.print("WiFi connecting to ");
  Serial.println(WIFI_SSID);

  WiFi.begin(WIFI_SSID, WIFI_PASSWORD);

  unsigned long start = millis();
  while (WiFi.status() != WL_CONNECTED && millis() - start < WIFI_ATTEMPT_TIMEOUT_MS) {
    delay(500);
    Serial.print('.');
  }
  Serial.println();

  if (WiFi.status() == WL_CONNECTED) {
    Serial.print("WiFi connected, IP ");
    Serial.println(WiFi.localIP());
    lcd.show("WiFi: " WIFI_SSID, WiFi.localIP().toString());
  } else {
    Serial.println("WiFi connect failed.");
    lcd.show("No WiFi", "check the network");
  }
}
