import { Haptics } from '@capacitor/haptics';

import { IS_NATIVE } from '@/lib/platform';

/**
 * A repeating buzz, standing in for React Native's `Vibration.vibrate(pattern, true)`.
 *
 * Patterns keep the native app's shape: milliseconds alternating wait and vibrate,
 * starting with a wait. Neither the browser's vibrate() nor the Haptics plugin repeats
 * a pattern on its own, so the cycle is walked here with timers, one buzz at a time.
 *
 * Inside the app each buzz goes through the Haptics plugin, which drives the phone's
 * vibrator directly. In a browser it is navigator.vibrate, which Android Chrome honours
 * and iOS Safari ignores, so a browser on an iPhone gets the sound without the buzz.
 */
let timer: ReturnType<typeof setTimeout> | null = null;
let run = 0;

function pulse(ms: number) {
  if (ms <= 0) return;

  if (IS_NATIVE) {
    void Haptics.vibrate({ duration: ms }).catch(() => undefined);
    return;
  }

  try {
    navigator.vibrate?.(ms);
  } catch {
    // A browser without a vibrator is not a failure; the alert still sounds.
  }
}

export function vibrate(pattern: number[], repeat: boolean) {
  cancelVibration();
  if (pattern.length === 0) return;

  const current = ++run;
  let index = 0;

  const step = () => {
    if (current !== run) return;

    if (index >= pattern.length) {
      if (!repeat) {
        timer = null;
        return;
      }
      index = 0;
    }

    const ms = pattern[index];
    // Odd positions are the buzzes; even ones are the waits between them.
    if (index % 2 === 1) pulse(ms);
    index += 1;
    timer = setTimeout(step, ms);
  };

  step();
}

export function cancelVibration() {
  run += 1;
  if (timer) clearTimeout(timer);
  timer = null;

  if (!IS_NATIVE) {
    try {
      navigator.vibrate?.(0);
    } catch {
      // Nothing was buzzing.
    }
  }
}
