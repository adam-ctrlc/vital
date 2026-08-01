#pragma once

#include <Arduino.h>

#define LCD_SDA_PIN 13  // board terminal P13
#define LCD_SCL_PIN 14  // board terminal P14
#define LCD_COLS 20
#define LCD_ROWS 4

#define PZEM_RX_PIN 16  // board terminal P16 (UART2 RX), PZEM TX wires here
#define PZEM_TX_PIN 17  // board terminal P17 (UART2 TX), PZEM RX wires here
#define DS18B20_PIN 32  // board terminal P32, DS18B20 yellow data wire
#define RELAY_PIN 5     // board terminal P5

#define RELAY_ON LOW
#define RELAY_OFF HIGH
