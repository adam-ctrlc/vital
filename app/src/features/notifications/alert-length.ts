import * as SecureStore from 'expo-secure-store';

const KEY = 'dynavolt.alertLength';

/**
 * Seconds. Half a minute at the bottom, ten minutes at the top.
 *
 * The slider is the only way to set this, so its notches are the whole range: every
 * reachable value is a multiple of the step, and nothing in between is valid.
 */
export const MIN_SECONDS = 30;
export const MAX_SECONDS = 600;
export const DEFAULT_SECONDS = 30;
export const STEP_SECONDS = 30;

/** Every position the slider can land on, for drawing the notches under it. */
export const STEPS: number[] = Array.from(
  { length: Math.floor((MAX_SECONDS - MIN_SECONDS) / STEP_SECONDS) + 1 },
  (_, index) => MIN_SECONDS + index * STEP_SECONDS
);

/**
 * The repeating buzz shape, in milliseconds: vibrate, pause, vibrate, longer pause.
 *
 * Repeated by the vibrator rather than expanded into one long array. At five minutes a
 * literal pattern would be a thousand entries, and Android caps how long a pattern it
 * accepts, so the duration is enforced by cancelling rather than by the pattern's
 * length.
 */
export const PULSE_PATTERN = [0, 400, 200, 400, 200, 600];

/**
 * How long the phone buzzes when an alert is raised.
 *
 * A duration rather than a pattern, because a pattern is not something anyone wants to
 * dial in. The shape above stays fixed and repeats to fill the chosen time.
 */
export async function loadAlertSeconds(): Promise<number> {
  try {
    const stored = await SecureStore.getItemAsync(KEY);
    const parsed = Number(stored);

    return Number.isFinite(parsed) && parsed >= MIN_SECONDS && parsed <= MAX_SECONDS
      ? parsed
      : DEFAULT_SECONDS;
  } catch {
    return DEFAULT_SECONDS;
  }
}

export async function saveAlertSeconds(seconds: number): Promise<void> {
  try {
    await SecureStore.setItemAsync(KEY, String(seconds));
  } catch {
    // Falls back to the default next launch. Not worth interrupting anyone over.
  }
}

/** Renders a duration the way someone would say it out loud. */
export function formatDuration(seconds: number): string {
  if (seconds < 60) {
    return `${seconds} ${seconds === 1 ? 'second' : 'seconds'}`;
  }

  const minutes = Math.floor(seconds / 60);
  const rest = seconds % 60;
  const minuteLabel = `${minutes} ${minutes === 1 ? 'minute' : 'minutes'}`;

  return rest === 0 ? minuteLabel : `${minuteLabel} ${rest}s`;
}
