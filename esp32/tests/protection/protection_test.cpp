// Runs the protection logic on a computer: ./run.sh from this folder.
#include <cmath>
#include <cstdio>

#include "../../src/core/Protection.h"

static int failures = 0;
#define CHECK(cond)                                               \
  do {                                                            \
    if (!(cond)) {                                                \
      std::printf("  FAIL %s:%d  %s\n", __FILE__, __LINE__, #cond); \
      failures++;                                                 \
    }                                                             \
  } while (0)

using State = Protection::State;
static const float NONE = NAN;

// Feeds one sample a second from `from` to `to` inclusive, in milliseconds.
static void feed(Protection &p, float va, uint32_t from, uint32_t to, float temp = 30.0f) {
  for (uint32_t t = from; t - from <= to - from; t += 1000) p.update(va, temp, t);
}

static void tripsAfterTheDelay() {
  Protection p;  // alarm 900, trip 980, 3 s delay
  p.update(1000, 30, 0);
  CHECK(p.state() == State::Warning);
  CHECK(p.takeAlarmEdge());
  CHECK(!p.takeAlarmEdge());
  feed(p, 1000, 1000, 2000);
  CHECK(p.shouldClose(2000));
  p.update(1000, 30, 3000);
  CHECK(p.tripped());
  CHECK(!p.shouldClose(3000));
}

static void aDipRestartsTheTripTimer() {
  Protection p;
  feed(p, 1000, 0, 2000);
  p.update(950, 30, 3000);  // under trip, still over alarm
  feed(p, 1000, 4000, 6000);
  CHECK(p.state() == State::Warning);
  p.update(1000, 30, 7000);
  CHECK(p.tripped());
}

static void reclosesThenLocksOut() {
  Protection p;
  p.setRecloseDelaySeconds(10);
  uint32_t t = 0;
  for (int attempt = 1; attempt <= Protection::MAX_RECLOSE_ATTEMPTS; attempt++) {
    feed(p, 1000, t, t + 3000);
    CHECK(p.tripped());
    t += 3000;
    feed(p, 0, t + 1000, t + 9000);  // contacts open, no current
    CHECK(p.tripped());
    t += 10000;
    p.update(0, 30, t);
    CHECK(p.state() == State::Normal);
    CHECK(p.attempts() == attempt);
    t += 1000;
  }
  feed(p, 1000, t, t + 3000);
  t += 3000;
  CHECK(p.tripped());
  feed(p, 0, t + 1000, t + 20000);
  CHECK(p.lockedOut());
  CHECK(!p.shouldClose(t + 20000));
}

static void aRecloseThatHoldsResetsTheCount() {
  Protection p;
  p.setRecloseDelaySeconds(5);
  feed(p, 1000, 0, 3000);
  feed(p, 0, 4000, 8000);
  CHECK(p.attempts() == 1);
  feed(p, 500, 9000, 9000 + Protection::RECLOSE_SURVIVED_MS);
  CHECK(p.attempts() == 0);
}

static void aMissingMeterNeitherTripsNorRecloses() {
  Protection p;
  feed(p, NONE, 0, 10000);
  CHECK(p.state() == State::Normal);
  CHECK(p.shouldClose(10000));

  Protection q;
  q.setRecloseDelaySeconds(5);
  feed(q, 1000, 0, 3000);
  feed(q, NONE, 4000, 60000);
  CHECK(q.tripped());
}

static void temperatureWarnsButNeverTrips() {
  Protection p;
  feed(p, 100, 0, 60000, 90.0f);
  CHECK(p.state() == State::Warning);
  CHECK(p.shouldClose(60000));
}

static void operatorOpenLocksAndCloseReleases() {
  Protection p;
  p.operatorOpen(0);
  CHECK(p.lockedOut());
  feed(p, 0, 1000, 700000);
  CHECK(!p.shouldClose(700000));
  CHECK(p.operatorClose(701000));
  CHECK(p.shouldClose(701000));
  CHECK(!p.lockedOut());
  CHECK(!p.operatorClose(702000));  // already closed
}

static void protectionUndoesAnOperatorCloseThenMakesThemWait() {
  Protection p;
  p.operatorOpen(0);
  CHECK(p.operatorClose(1000));
  feed(p, 1000, 2000, 5000);
  CHECK(p.tripped());
  CHECK(!p.operatorClose(6000));
  CHECK(p.operatorClose(5000 + Protection::MANUAL_RETRY_MS));
}

static void restoredTripStaysOpen() {
  Protection p;
  p.restore(true, true, 0);
  CHECK(p.lockedOut());
  feed(p, 0, 0, 700000);
  CHECK(!p.shouldClose(700000));

  Protection q;
  q.setRecloseDelaySeconds(5);
  q.restore(true, false, 0);
  feed(q, 0, 1000, 4000);
  CHECK(q.tripped());
  q.update(0, 30, 5000);
  CHECK(q.shouldClose(5000));
}

static void holdOpenAfterABrownout() {
  Protection p;
  p.holdOpenUntil(20000);
  p.update(100, 30, 0);
  CHECK(!p.shouldClose(19999));
  CHECK(p.secondsHeldOpen(10000) == 10);
  CHECK(p.shouldClose(20000));
}

static void rejectsBadSettings() {
  Protection p;
  CHECK(!p.setLimits({900, 900, 40}));   // trip must be above alarm
  CHECK(!p.setLimits({0, 980, 40}));
  CHECK(!p.setLimits({900, 2500, 40}));
  CHECK(!p.setLimits({900, 980, NAN}));
  CHECK(p.limits().tripVa == 980);
  CHECK(p.setLimits({500, 900, 70}));
  CHECK(!p.setTripDelaySeconds(0));
  CHECK(!p.setTripDelaySeconds(61));
  CHECK(!p.setRecloseDelaySeconds(4));
  CHECK(p.setRecloseDelaySeconds(600));
}

static void survivesTheMillisWrap() {
  Protection p;
  const uint32_t start = 0xFFFFFFFFu - 1500;  // wraps between samples
  feed(p, 1000, start, start + 3000);
  CHECK(p.tripped());
  CHECK(p.secondsUntilReclose(start + 4000) == 29);
}

static void countdownsForTheDisplay() {
  Protection p;
  p.update(1000, 30, 0);
  CHECK(p.secondsUntilTrip(0) == 3);
  CHECK(p.secondsUntilTrip(2500) == 1);
  feed(p, 1000, 1000, 3000);
  CHECK(p.secondsUntilTrip(3000) == 0);
  CHECK(p.secondsUntilReclose(3000) == 30);
}

int main() {
  struct { const char *name; void (*run)(); } tests[] = {
      {"trips after the delay", tripsAfterTheDelay},
      {"a dip restarts the trip timer", aDipRestartsTheTripTimer},
      {"recloses then locks out", reclosesThenLocksOut},
      {"a reclose that holds resets the count", aRecloseThatHoldsResetsTheCount},
      {"a missing meter neither trips nor recloses", aMissingMeterNeitherTripsNorRecloses},
      {"temperature warns but never trips", temperatureWarnsButNeverTrips},
      {"operator open locks, close releases", operatorOpenLocksAndCloseReleases},
      {"protection undoes an operator close, then makes them wait", protectionUndoesAnOperatorCloseThenMakesThemWait},
      {"a restored trip stays open", restoredTripStaysOpen},
      {"hold open after a brownout", holdOpenAfterABrownout},
      {"rejects bad settings", rejectsBadSettings},
      {"survives the millis wrap", survivesTheMillisWrap},
      {"countdowns for the display", countdownsForTheDisplay},
  };
  for (auto &test : tests) {
    const int before = failures;
    test.run();
    std::printf("%s %s\n", failures == before ? "ok  " : "FAIL", test.name);
  }
  std::printf(failures ? "\n%d check(s) failed\n" : "\nall passed\n", failures);
  return failures ? 1 : 0;
}
