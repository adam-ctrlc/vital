#pragma once

#include <Arduino.h>

#define LCD_SDA_PIN 13  // board terminal P13
#define LCD_SCL_PIN 14  // board terminal P14
#define LCD_COLS 20
#define LCD_ROWS 4

#define PZEM_RX_PIN 16  // board terminal P16 (UART2 RX), PZEM TX wires here
#define PZEM_TX_PIN 17  // board terminal P17 (UART2 TX), PZEM RX wires here
#define DS18B20_PIN 32  // board terminal P32, DS18B20 yellow data wire
#define RELAY_PIN 18    // board terminal P18

// How the module's IN pin is driven, which decides the polarity below.
//
//   0  the ESP32 drives IN directly. The module is active low, so closing the
//      contacts drives the pin LOW.
//
//   1  an NPN sits between them: GPIO through 4.7k to the base, collector to IN,
//      emitter to a ground shared with the module. The transistor inverts, so
//      closing now drives the pin HIGH.
//
// The transistor is there because a 3.3V pin cannot switch this module off. IN is
// pulled up to 5V inside the module, so driving it to 3.3V leaves 1.7V across the
// opto LED: it keeps conducting, the input LED glows dim instead of going dark, and
// near the threshold it chatters. The transistor never sources 5V, it just gets out
// of the way and lets the module's own pull-up reach the full rail.
//
// It also improves the boot state. Before pinMode() runs the pin is high impedance,
// which means no base current, which means the transistor is off and the load is
// de-energized from the instant power arrives.
//
// Setting this to match the wiring is not cosmetic. Get it wrong and the relay is
// closed exactly when the firmware believes it is open.
#define RELAY_VIA_TRANSISTOR 1

#if RELAY_VIA_TRANSISTOR
#define RELAY_ON HIGH
#define RELAY_OFF LOW
#else
#define RELAY_ON LOW
#define RELAY_OFF HIGH
#endif
