// Joins Wi-Fi and checks the API every 5 s. Uses ../../secrets.h.
#include <HTTPClient.h>
#include <WiFi.h>
#include <WiFiClientSecure.h>

#include "../../secrets.h"
#include "../../src/Config.h"

WiFiClientSecure tls;

void setup() {
  Serial.begin(115200);
  WiFi.mode(WIFI_STA);
  WiFi.setSleep(false);
  WiFi.begin(WIFI_SSID, WIFI_PASSWORD);
  tls.setInsecure();
  Serial.printf("net test: joining %s\n", WIFI_SSID);
}

void loop() {
  delay(5000);
  if (WiFi.status() != WL_CONNECTED) {
    Serial.println("WiFi not connected yet");
    return;
  }
  HTTPClient http;
  http.begin(tls, String(BACKEND_URL) + "/api/v1/health");
  const int code = http.GET();
  Serial.printf("IP %s RSSI %d dBm, GET /health -> %d\n", WiFi.localIP().toString().c_str(), WiFi.RSSI(), code);
  http.end();
}
