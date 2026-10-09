#include "WifiLink.h"

// Only the implementation needs the credentials, so they stop here rather than
// reaching everything that includes the header.
#include "../../secrets.h"

volatile uint8_t WifiLink::lastReason = 0;
volatile uint16_t WifiLink::dropCount = 0;
volatile bool WifiLink::joined = false;

void WifiLink::begin() {
  // Registered once: the handler outlives a radio restart.
  WiFi.onEvent(onDisconnected, ARDUINO_EVENT_WIFI_STA_DISCONNECTED);
  WiFi.onEvent(onGotIp, ARDUINO_EVENT_WIFI_STA_GOT_IP);
  applyRadioSettings();
}

void WifiLink::applyRadioSettings() {
  // The credentials are compiled in, so there is nothing to remember between boots.
  // Left on, the driver spends a flash erase cycle on them at every begin().
  WiFi.persistent(false);

  WiFi.mode(WIFI_STA);
  WiFi.setAutoReconnect(true);
  WiFi.setSleep(WIFI_MODEM_SLEEP);

  // After the mode, which is what powers the radio: set before, it does not stick.
  WiFi.setTxPower(WIFI_TX_POWER);
}

void WifiLink::restartRadio() {
  Serial.println("WiFi still down, restarting the radio");
  WiFi.disconnect(true);
  WiFi.mode(WIFI_OFF);
  delay(200);
  applyRadioSettings();
}

void WifiLink::onDisconnected(arduino_event_id_t, arduino_event_info_t info) {
  lastReason = info.wifi_sta_disconnected.reason;
  dropCount = dropCount + 1;
}

void WifiLink::onGotIp(arduino_event_id_t, arduino_event_info_t) {
  joined = true;
}

void WifiLink::reconnect() {
  Serial.println("WiFi reports connected but nothing gets through, rejoining");
  WiFi.disconnect();
  connect();
}

void WifiLink::connect() {
  if (joined) {
    joined = false;
    failedAttempts = 0;
  }

  if (WiFi.status() == WL_CONNECTED) return;

  // The reason the access point or the driver gave, so a drop can be told apart from a
  // weak signal (BEACON_TIMEOUT, NO_AP_FOUND) or a hotspot that kicked the board off.
  if (dropCount != reportedDrops) {
    reportedDrops = dropCount;
    const uint8_t reason = lastReason;
    Serial.print("WiFi down, last reason ");
    Serial.print(reason);
    Serial.print(" ");
    Serial.println(WiFi.disconnectReasonName((wifi_err_reason_t)reason));
  }

  if (failedAttempts >= WIFI_RESTART_AFTER_ATTEMPTS) {
    failedAttempts = 0;
    restartRadio();
  } else {
    // Stops whatever attempt the supplicant already has in flight. setAutoReconnect
    // means one is usually running, and begin() on top of that is refused with "sta is
    // connecting, cannot set config", leaving the radio in the scan-and-associate state,
    // its highest draw, while the loop below waits out a timeout for nothing.
    WiFi.disconnect();
  }

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
    Serial.print(WiFi.localIP());
    Serial.print(" RSSI ");
    Serial.println(WiFi.RSSI());
    lcd.show("WiFi: " WIFI_SSID, WiFi.localIP().toString());
  } else {
    failedAttempts++;
    Serial.println("WiFi connect failed.");
    lcd.show("No WiFi", "check the network");
  }
}
