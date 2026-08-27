#pragma once

#include <WebServer.h>

#include "../core/Monitor.h"

/// Serves the current reading to anything on the same network.
///
/// The point is latency: through the backend a number takes a TLS post, a database
/// write and a poll on the other side, while on a shared network the app can ask the
/// board directly and have it in milliseconds.
///
/// A live view, not a record. Nothing here is stored and the backend still gets its own
/// posts, alerts included, because those have to reach phones off this network.
///
/// Plain HTTP on purpose: a device on a local address cannot hold a certificate anyone
/// would trust, and a self-signed one trains people to click through warnings. What it
/// exposes is what the app already shows, to callers already inside the network.
class LiveServer {
 public:
  explicit LiveServer(Monitor &monitor) : monitor(monitor), server(PORT) {}

  void begin();

  /// Called every pass. The loop it sits in also runs the trip timer, so this must
  /// never wait on a client.
  void loop() { server.handleClient(); }

 private:
  static constexpr uint16_t PORT = 80;

  void cors();

  /// Emits a number, or `null` when the sensor did not give one. Never a bare `nan`,
  /// which is not valid JSON and would throw in the parser at the worst moment.
  static void appendNumber(String &out, const char *key, float value, int digits);

  void sendLive();

  Monitor &monitor;
  WebServer server;
};
