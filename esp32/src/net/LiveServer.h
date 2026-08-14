#pragma once

#include <WebServer.h>

#include "../core/Monitor.h"

/// Serves the current reading to anything on the same network.
///
/// The point is latency. Going through the backend means a TLS post, a database write
/// and a poll on the other side, so the app sees a number seconds after the board took
/// it. On a shared network, and a phone hotspot is one, the app can ask the board
/// directly and have it in milliseconds.
///
/// This is a live view, not a record. Nothing here is stored, and the backend still
/// gets its own posts on their own schedule: the two paths answer different questions
/// and neither replaces the other. Alerts in particular stay with the backend, because
/// they have to reach phones that are not on this network.
///
/// Plain HTTP on purpose. A device on a local address cannot hold a certificate anyone
/// would trust, and the alternative, a self-signed one, trains people to click through
/// warnings. What it exposes is what the app already shows and what the backend already
/// has, to callers who are already inside the network.
class LiveServer {
 public:
  explicit LiveServer(Monitor &monitor) : monitor(monitor), server(PORT) {}

  void begin();

  /// Non-blocking, and called every pass. The loop it sits in also runs the trip timer,
  /// so this must never wait on a client.
  void loop() { server.handleClient(); }

 private:
  static constexpr uint16_t PORT = 80;

  void cors();

  /// Emits a number, or `null` when the sensor did not give one.
  ///
  /// Never a bare `nan`: that is not valid JSON and would throw in the parser at exactly
  /// the moment a sensor had failed, which is when the reading matters most.
  static void appendNumber(String &out, const char *key, float value, int digits);

  void sendLive();

  Monitor &monitor;
  WebServer server;
};
