#include "Ds18b20Test.h"

Ds18b20Test::Ds18b20Test() : oneWire(DS18B20_PIN), sensors(&oneWire) {}

void Ds18b20Test::begin() {
  Serial.begin(115200);
  delay(200);
  Serial.println();
  Serial.println("DS18B20 test");
  Serial.println("Wiring: Red to 3V3, Black to GND, Yellow to P32 (GPIO32).");
  Serial.println("Internal pull-up on, testing resistor-free first.");

  pinMode(DS18B20_PIN, INPUT_PULLUP);
  sensors.begin();

  int count = sensors.getDeviceCount();
  Serial.print("Devices on the bus: ");
  Serial.println(count);

  if (count == 0) {
    Serial.println("None found. Recheck the three wires.");
    Serial.println("If wiring is correct, add a 4.7k resistor from Yellow to Red and retry.");
    return;
  }

  DeviceAddress addr;
  for (int i = 0; i < count; i++) {
    if (!sensors.getAddress(addr, i)) continue;
    Serial.print("  device ");
    Serial.print(i);
    Serial.print(": ");
    printAddress(addr);
    Serial.print("  family=0x");
    Serial.print(addr[0], HEX);
    Serial.println(addr[0] == 0x28 ? "  DS18B20 confirmed" : "  not a DS18B20");
  }
}

void Ds18b20Test::loop() {
  if (millis() - lastRead < 1000) return;
  lastRead = millis();

  sensors.requestTemperatures();
  float c = sensors.getTempCByIndex(0);

  if (c == DEVICE_DISCONNECTED_C) {
    Serial.println("read failed (-127): device not responding, check wiring.");
    return;
  }
  if (c == 85.0f) {
    Serial.println("reads 85.00: conversion did not complete, likely needs the 4.7k resistor.");
    return;
  }

  Serial.print("temperature: ");
  Serial.print(c, 2);
  Serial.println(" C");
}

void Ds18b20Test::printAddress(DeviceAddress addr) {
  for (uint8_t i = 0; i < 8; i++) {
    if (addr[i] < 16) Serial.print('0');
    Serial.print(addr[i], HEX);
    if (i < 7) Serial.print(':');
  }
}
