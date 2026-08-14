/**
 * How long the board holds the load off before trying to close again.
 *
 * Seconds, five to five minutes. The API enforces the same range, and the lower bound
 * matters: below a few seconds it is not a wait at all, and the relay would chatter
 * between a fault and an attempt to re-energise it.
 *
 * A server setting rather than a device one, unlike the alert length beside it in the
 * app. That is a preference about a phone; this is behaviour of a relay, shared by
 * everyone looking at the same transformer, and it reaches the board on its heartbeat.
 */
export const MIN_SECONDS = 5;
export const MAX_SECONDS = 300;
export const DEFAULT_SECONDS = 30;
export const STEP_SECONDS = 5;

/**
 * Where to draw a notch. Every thirty seconds rather than every step.
 *
 * There are sixty positions on this slider; a notch for each would be a grey smear.
 * The first is the minimum, so the left end is marked as an actual value rather than
 * looking like the track simply starts there.
 */
export const TICKS: number[] = [
  MIN_SECONDS,
  ...Array.from({ length: MAX_SECONDS / 30 }, (_, index) => (index + 1) * 30),
];

/** Renders a duration the way someone would say it out loud. */
export function formatDelay(seconds: number): string {
  if (seconds < 60) return `${seconds} seconds`;

  const minutes = Math.floor(seconds / 60);
  const rest = seconds % 60;
  const label = `${minutes} ${minutes === 1 ? 'minute' : 'minutes'}`;

  return rest === 0 ? label : `${label} ${rest}s`;
}
