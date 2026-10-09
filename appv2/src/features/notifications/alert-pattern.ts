import {
  BroadcastIcon,
  LightningIcon,
  VibrateIcon,
  WaveformIcon,
  type Icon,
} from '@phosphor-icons/react';

import * as storage from '@/lib/storage';

const KEY = 'dynavolt.alertPattern';

export type AlertPatternName = 'steady' | 'rapid' | 'long' | 'sos';

/**
 * The buzz shapes an alert can use.
 *
 * Vibration only. The tone is a separate setting, because the two are not alternatives:
 * a pattern is what you feel in a pocket and a tone is what you hear across a room, and
 * an alert wants both.
 *
 * Each `pulse` is one cycle in milliseconds, alternating wait and vibrate starting
 * with a wait, which is why every one begins with a zero: that makes it start at once
 * rather than after a pause. The vibrator repeats the cycle to fill the chosen length.
 */
export const ALERT_PATTERNS: {
  value: AlertPatternName;
  label: string;
  description: string;
  pulse: number[];
  icon: Icon;
}[] = [

  {
    value: 'long',
    label: 'Long',
    description: 'One long buzz per cycle. Easiest to feel through a bag.',
    pulse: [0, 1200, 400],
    icon: VibrateIcon,
  },

  {
    value: 'rapid',
    label: 'Rapid',
    description: 'Short quick taps. Reads as urgent.',
    pulse: [0, 120, 90, 120, 90, 120, 400],
    icon: LightningIcon,
  },

  {
    value: 'sos',
    label: 'SOS',
    description: 'Three short, three long, three short. Unmistakable.',
    pulse: [
      0, 150, 100, 150, 100, 150, 300, 450, 100, 450, 100, 450, 300, 150, 100, 150, 100, 150,
      800,
    ],
    icon: BroadcastIcon,
  },
  {
    value: 'steady',
    label: 'Steady',
    description: 'Even pulses. Noticeable without being frantic.',
    pulse: [0, 400, 200, 400, 200, 600],
    icon: WaveformIcon,
  },
];

export const DEFAULT_PATTERN: AlertPatternName = 'steady';

/** The pulse for a name, falling back to the default if the stored value is unknown. */
export function pulseFor(name: AlertPatternName): number[] {
  const found = ALERT_PATTERNS.find((pattern) => pattern.value === name);

  return found?.pulse ?? ALERT_PATTERNS[0].pulse;
}

export async function loadAlertPattern(): Promise<AlertPatternName> {
  try {
    const stored = await storage.getItem(KEY);

    return ALERT_PATTERNS.some((pattern) => pattern.value === stored)
      ? (stored as AlertPatternName)
      : DEFAULT_PATTERN;
  } catch {
    return DEFAULT_PATTERN;
  }
}

export async function saveAlertPattern(name: AlertPatternName): Promise<void> {
  try {
    await storage.setItem(KEY, name);
  } catch {
    // Falls back to the default next launch. Not worth interrupting anyone over.
  }
}
