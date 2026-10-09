#pragma once

#define DEVICE_ID "vital-esp32-01"
#define FIRMWARE_VERSION "2.0.0"

// Pins: see pins.txt
#define LCD_SDA_PIN 13
#define LCD_SCL_PIN 14
#define LCD_COLS 20
#define LCD_ROWS 4
#define PZEM_RX_PIN 16  // PZEM TX wires here (UART2 RX)
#define PZEM_TX_PIN 17  // PZEM RX wires here (UART2 TX)
#define DS18B20_PIN 32
#define RELAY_PIN 18

// 1 = relay IN driven through an NPN (close = HIGH), 0 = IN wired straight to the pin (close = LOW)
#define RELAY_VIA_TRANSISTOR 1

// Protection task
#define SAMPLE_INTERVAL_MS 1000
#define PROTECTION_TASK_CORE 1
#define PROTECTION_TASK_PRIORITY 5
#define PROTECTION_WATCHDOG_MS 10000
// keeps the flash write off the relay coil's inrush
#define PERSIST_SETTLE_MS 300
// after a brownout reset the relay stays open 10 s per brownout in a row, so it can't click-reboot loop
#define BROWNOUT_HOLD_MS 10000
#define BROWNOUT_HOLD_MAX_COUNT 6
#define STABLE_AFTER_MS 60000

// Network
#define POST_INTERVAL_MS 5000
#define HEARTBEAT_INTERVAL_MS 30000
#define HTTP_CONNECT_TIMEOUT_MS 5000
#define HTTP_RESPONSE_TIMEOUT_MS 8000
#define TLS_HANDSHAKE_TIMEOUT_S 8
// below the 19.5 dBm default to soften current peaks on the 5 V rail; raise if the AP is far
#define WIFI_TX_POWER WIFI_POWER_13dBm
#define WIFI_RESTART_AFTER_MS 60000
#define WIFI_DEAD_LINK_MS 90000

// 1 wipes the saved trip, lockout and settings at boot: flash once, then set back to 0
#define CLEAR_SAVED_STATE 0
