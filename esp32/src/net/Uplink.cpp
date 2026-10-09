#include "Uplink.h"

#include "../core/Boot.h"

void Uplink::begin() {
  wifi.begin();
  live.begin();
}

void Uplink::loop() {
  const uint32_t now = millis();
  wifi.loop(now, lastAnswer);

  const bool online = wifi.online();
  controller.setOnline(online);
  if (online != wasOnline) {
    wasOnline = online;
    if (!online) backend.disconnect();
    heartbeatDue = online;
  }
  if (!online) return;

  const Snapshot s = controller.snapshot();

  // Alarm crossings and relay moves are posted at once.
  if (s.changes != postedChanges || now - lastPost >= POST_INTERVAL_MS) {
    postedChanges = s.changes;
    lastPost = now;
    handle(backend.postReading(s, Boot::lastCommandId()), s, false);
  }

  if (heartbeatDue || now - lastHeartbeat >= HEARTBEAT_INTERVAL_MS) {
    heartbeatDue = false;
    lastHeartbeat = now;
    handle(backend.postHeartbeat(s, Boot::lastCommandId(), Boot::resetReason()), s, true);
  }
}

void Uplink::handle(const Backend::Reply &reply, const Snapshot &s, bool heartbeat) {
  if (reply.answered()) lastAnswer = millis();
  if (!reply.ok()) return;

  // The API repeats a command until acked; id 0 is the older API, which sends each once.
  if (reply.command != Backend::RelayCommand::None &&
      (reply.commandId == 0 || reply.commandId > Boot::lastCommandId())) {
    controller.send({reply.command == Backend::RelayCommand::Open ? Command::Open : Command::Close});
    if (reply.commandId) Boot::setLastCommandId(reply.commandId);
  }
  if (!heartbeat) return;

  const Protection::Limits &l = reply.limits;
  if (!isnan(l.alarmVa) && !isnan(l.tripVa) && !isnan(l.tempC) &&
      (fabsf(l.alarmVa - s.limits.alarmVa) >= 0.05f || fabsf(l.tripVa - s.limits.tripVa) >= 0.05f ||
       fabsf(l.tempC - s.limits.tempC) >= 0.05f)) {
    controller.send({Command::SetLimits, l});
  }
  if (reply.tripDelaySeconds && reply.tripDelaySeconds != s.tripDelaySeconds) {
    controller.send({Command::SetTripDelay, {}, reply.tripDelaySeconds});
  }
  if (reply.recloseDelaySeconds && reply.recloseDelaySeconds != s.recloseDelaySeconds) {
    controller.send({Command::SetRecloseDelay, {}, reply.recloseDelaySeconds});
  }
}
