// VITAL board firmware. Hardware bring-up sketches are in tests/.
#include "src/core/Boot.h"
#include "src/core/Controller.h"
#include "src/net/Uplink.h"

Controller controller;
Uplink uplink(controller);

void setup() {
  Serial.begin(115200);
  Boot::begin();
  controller.begin();
  uplink.begin();
}

void loop() {
  uplink.loop();
  delay(10);
}
