#include "Wifi.h"

#include "../../secrets.h"
#include "../Config.h"

void Wifi::begin() {
  WiFi.onEvent(onDisconnected, ARDUINO_EVENT_WIFI_STA_DISCONNECTED);
  Serial.printf("WiFi connecting to %s\n", WIFI_SSID);
  start();
}

void Wifi::start() {
  WiFi.persistent(false);
  WiFi.mode(WIFI_STA);
  // Modem sleep makes the board miss hotspot beacons and get dropped.
  WiFi.setSleep(false);
  WiFi.setAutoReconnect(true);
  WiFi.begin(WIFI_SSID, WIFI_PASSWORD);
  WiFi.setTxPower(WIFI_TX_POWER);  // only sticks once the radio is up
}

static volatile uint8_t lastReason = 0;

void Wifi::onDisconnected(arduino_event_id_t, arduino_event_info_t info) {
  const uint8_t reason = info.wifi_sta_disconnected.reason;
  if (reason == lastReason) return;
  lastReason = reason;
  Serial.printf("WiFi down: %u %s\n", reason, WiFi.disconnectReasonName((wifi_err_reason_t)reason));
}

void Wifi::loop(uint32_t now, uint32_t lastAnswerAt) {
  if (online()) {
    if (!wasOnline) {
      wasOnline = true;
      lastReason = 0;
      onlineSince = lastAction = now;
      Serial.printf("WiFi connected after %lus, IP %s, RSSI %d dBm, live view at http://%s/live\n",
                    (unsigned long)((now - downSince) / 1000), WiFi.localIP().toString().c_str(), WiFi.RSSI(),
                    WiFi.localIP().toString().c_str());
    }
    const uint32_t heard = (int32_t)(lastAnswerAt - onlineSince) > 0 ? lastAnswerAt : onlineSince;
    if (now - heard >= WIFI_DEAD_LINK_MS && now - lastAction >= WIFI_DEAD_LINK_MS) {
      lastAction = now;
      Serial.println("WiFi says connected but the API has not answered in 90 s, rejoining");
      WiFi.reconnect();
    }
    return;
  }

  if (wasOnline) {
    wasOnline = false;
    downSince = lastAction = now;
  }
  if (now - downSince >= WIFI_RESTART_AFTER_MS && now - lastAction >= WIFI_RESTART_AFTER_MS) {
    lastAction = now;
    Serial.println("WiFi down a minute, restarting the radio");
    WiFi.mode(WIFI_OFF);
    start();
  }
}
