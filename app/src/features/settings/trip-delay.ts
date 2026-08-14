/**
 * How long the load must stay above the trip threshold before the relay opens.
 *
 * The opposite of the reclose delay beside it, and easy to confuse with it: this wait
 * runs while the load is still connected and decides whether to cut it, that one runs
 * while it is disconnected and decides when to try again.
 *
 * One second to a minute, matched by the API and the database. The floor is a second
 * rather than none because a transformer draws several times its rated current for a
 * fraction of a second at switch-on; at zero the board would cut the load on that
 * inrush every time it closed and never get past it.
 *
 * Names are prefixed rather than shared with the reclose module, because both sets are
 * imported into the same screen and a bare MAX_SECONDS in that file would be a coin
 * toss over which slider it belonged to.
 */
export const TRIP_MIN_SECONDS = 1;
export const TRIP_MAX_SECONDS = 60;
export const TRIP_DEFAULT_SECONDS = 3;
export const TRIP_STEP_SECONDS = 1;

/**
 * Where to draw a notch. Every ten seconds, plus the minimum.
 *
 * Sixty positions with a notch on each would be a grey smear, and the first notch sits
 * on the minimum so the left end reads as a real value rather than the track just
 * starting there.
 */
export const TRIP_TICKS: number[] = [
  TRIP_MIN_SECONDS,
  ...Array.from({ length: TRIP_MAX_SECONDS / 10 }, (_, index) => (index + 1) * 10),
];
