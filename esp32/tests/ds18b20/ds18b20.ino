// Lists the probes on the bus, then prints the temperature every second.
#include <DallasTemperature.h>
#include <OneWire.h>

#include "../../src/Config.h"

OneWire wire(DS18B20_PIN);
DallasTemperature probe(&wire);

void setup() {
  Serial.begin(115200);
  pinMode(DS18B20_PIN, INPUT_PULLUP);
  probe.begin();
  Serial.printf("DS18B20 test: %d probe(s) on P32\n", probe.getDeviceCount());
}

void loop() {
  probe.requestTemperatures();
  const float c = probe.getTempCByIndex(0);
  if (c == DEVICE_DISCONNECTED_C) Serial.println("no answer (-127): check the wiring");
  else if (c == 85.0f) Serial.println("85.00: conversion did not finish, add a 4.7k from data to 3V3");
  else Serial.printf("%.2f C\n", c);
  delay(1000);
}
