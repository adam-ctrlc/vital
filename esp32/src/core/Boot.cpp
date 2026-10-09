#include "Boot.h"

#include <esp_attr.h>
#include <esp_system.h>

static constexpr uint32_t MAGIC = 0x56495431;  // RTC memory is garbage after power-on

RTC_NOINIT_ATTR static uint32_t magic;
RTC_NOINIT_ATTR static uint32_t brownouts;
RTC_NOINIT_ATTR static uint32_t commandId;

static esp_reset_reason_t reason = ESP_RST_UNKNOWN;

void Boot::begin() {
  reason = esp_reset_reason();
  if (magic != MAGIC || reason == ESP_RST_POWERON) {
    magic = MAGIC;
    brownouts = 0;
    commandId = 0;
  }
  if (reason == ESP_RST_BROWNOUT || reason == ESP_RST_PWR_GLITCH) brownouts++;

  Serial.printf("boot: reset=%s brownouts=%lu\n", resetReason(), (unsigned long)brownouts);
}

const char *Boot::resetReason() {
  switch (reason) {
    case ESP_RST_POWERON: return "poweron";
    case ESP_RST_BROWNOUT:
    case ESP_RST_PWR_GLITCH: return "brownout";
    case ESP_RST_PANIC: return "panic";
    case ESP_RST_TASK_WDT: return "task_wdt";
    case ESP_RST_INT_WDT: return "int_wdt";
    case ESP_RST_SW: return "sw";
    case ESP_RST_DEEPSLEEP: return "deepsleep";
    case ESP_RST_EXT: return "ext";
    default: return "other";
  }
}

uint32_t Boot::brownoutsInARow() { return brownouts; }

void Boot::markStable() { brownouts = 0; }

uint32_t Boot::lastCommandId() { return commandId; }

void Boot::setLastCommandId(uint32_t id) { commandId = id; }
