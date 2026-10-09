/**
 * Whether the relay buttons should still be held after a command was sent.
 *
 * Pulled out of the card so it can be exercised on its own. The decision has more
 * edges than it looks: a position that is merely unknown must not be mistaken for the
 * one that was asked for, and a board that never answers must not hold the buttons
 * for good.
 */
export type RelayWait = {
  /** The position asked for. True means closed. */
  closed: boolean;
  /** When to stop waiting, as an epoch millisecond count. */
  until: number;
};

export type WaitOutcome =
  /** The board has not reported the asked-for position yet. Keep the buttons held. */
  | 'hold'
  /** It reported it. Release, and clear the "sent" note. */
  | 'moved'
  /** It never did. Release, and say so. */
  | 'timeout';

/**
 * `reported` is the position from the newest hardware reading: true closed, false open,
 * null or undefined when the board has not said or the link has gone stale.
 *
 * Unknown is deliberately not a match. It is what a disconnected board reports, and
 * treating it as agreement would release the buttons on a relay nobody can see.
 */
export function relayWaitOutcome(
  wait: RelayWait,
  reported: boolean | null | undefined,
  now: number
): WaitOutcome {
  if (reported === wait.closed) return 'moved';

  // Checked after the match, so a command that lands in the same instant it expires is
  // read as having worked rather than as having failed.
  if (now >= wait.until) return 'timeout';

  return 'hold';
}
