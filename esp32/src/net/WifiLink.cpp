#include "WifiLink.h"

// Only the implementation needs the credentials, so they stop here rather than
// reaching everything that includes the header.
#include "../../secrets.h"

void WifiLink::begin() {
  WiFi.mode(WIFI_STA);
  WiFi.setAutoReconnect(true);

  // The credentials are compiled in, so there is nothing to remember between boots.
  // Left on, the driver spends a flash erase cycle on them at every begin().
  WiFi.persistent(false);

  // Modem sleep between beacons. Already the station default, said out loud because it
  // is the difference between holding the receiver up and waking for the beacon, and
  // this board has no current to spare.
  WiFi.setSleep(true);

  WiFi.setTxPower(WIFI_TX_POWER);
}

void WifiLink::connect() {
  if (WiFi.status() == WL_CONNECTED) return;

  // Stops whatever attempt the supplicant already has in flight. setAutoReconnect means
  // one is usually running, and begin() on top of that is refused with "sta is
  // connecting, cannot set config", leaving the radio in the scan-and-associate state,
  // its highest draw, while the loop below waits out a timeout for nothing.
  //
  // The mode is not set again here either: it was set in begin(), and re-setting it
  // restarts the radio.
  WiFi.disconnect();

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
