/** What a restart reason means, for someone who is not reading the firmware. */
const LABELS: Record<string, string> = {
  poweron: 'Powered on',
  brownout: 'Power dip (brownout)',
  panic: 'Crashed',
  task_wdt: 'Watchdog reset',
  int_wdt: 'Watchdog reset',
  wdt: 'Watchdog reset',
  sw: 'Restarted by firmware',
  deepsleep: 'Woke from sleep',
  ext: 'Reset button',
  other: 'Unknown',
};

/** Restarts the board did not choose: worth a second look at the wiring or the supply. */
const UNPLANNED = new Set(['brownout', 'panic', 'task_wdt', 'int_wdt', 'wdt']);

export function resetReasonLabel(reason: string): string {
  return LABELS[reason] ?? 'Unknown';
}

export function isUnplannedReset(reason: string): boolean {
  return UNPLANNED.has(reason);
}
