import { CapacitorHttp } from '@capacitor/core';

import type { LiveReading } from '@/features/readings/types';
import { IS_NATIVE } from '@/lib/platform';

/**
 * How long to wait for the board before giving up on it.
 *
 * Short on purpose. This runs on a poll, and a request that outlives its own interval
 * would stack rather than fail. On a local network a board that is there answers in
 * tens of milliseconds; one that takes longer than this is not reachable in any way
 * worth waiting for.
 */
const TIMEOUT_MS = 700;

/** What the board serves at `/live`. A subset of the backend's reading. */
type BoardReading = {
  voltageV: number | null;
  currentA: number | null;
  temperatureC: number | null;
  powerW: number | null;
  powerFactor: number | null;
  frequencyHz: number | null;
  energyKwh: number | null;
  status: string;
  relay: string;
  uptimeSeconds: number;
};

const NUMBER_FIELDS = ['voltageV', 'currentA', 'temperatureC', 'powerW', 'powerFactor', 'frequencyHz', 'energyKwh'];

/** Anything else at that address (a stale IP now used by another device, an error page) is ignored. */
function isBoardReading(value: unknown): value is BoardReading {
  if (typeof value !== 'object' || value === null) return false;
  const fields = value as Record<string, unknown>;
  return (
    NUMBER_FIELDS.every((key) => fields[key] === null || typeof fields[key] === 'number') &&
    typeof fields.status === 'string' &&
    typeof fields.relay === 'string'
  );
}

/**
 * Reads the board directly, over whatever network both happen to be on.
 *
 * The backend path costs a post, a database write and a poll on the other side, so a
 * number reaches the app seconds after the board measured it. When the phone can see
 * the board, asking it is immediate and costs nobody anything.
 *
 * Returns null rather than throwing whenever this is not available, which is most of
 * the time: a different network, no board, an address that has moved. The caller treats
 * null as "use the backend", so the fast path can fail as often as it likes.
 */
export async function readBoard(ip: string, signal?: AbortSignal): Promise<BoardReading | null> {
  if (signal?.aborted) return null;

  // The board serves plain HTTP on the LAN. Inside the app that goes through the native
  // stack, which a WebView loaded over https would otherwise refuse as mixed content.
  // In a browser it only works when the site itself is served over http, which is the
  // local dev server; a deployed https site falls back to the backend, as designed.
  if (IS_NATIVE) {
    try {
      const response = await CapacitorHttp.get({
        url: `http://${ip}/live`,
        connectTimeout: TIMEOUT_MS,
        readTimeout: TIMEOUT_MS,
        responseType: 'json',
      });
      if (signal?.aborted || response.status < 200 || response.status >= 300) return null;

      return isBoardReading(response.data) ? response.data : null;
    } catch {
      return null;
    }
  }

  // Its own deadline, and also honours the caller's. A poll that is being torn down
  // should not be kept alive by a request that has not timed out yet.
  const timeout = new AbortController();
  const timer = setTimeout(() => timeout.abort(), TIMEOUT_MS);
  const onAbort = () => timeout.abort();
  signal?.addEventListener('abort', onAbort);

  try {
    const response = await fetch(`http://${ip}/live`, { signal: timeout.signal });
    if (!response.ok) return null;

    const body: unknown = await response.json();
    return isBoardReading(body) ? body : null;
  } catch {
    // Unreachable, too slow, not a board, blocked as mixed content, or the poll was
    // cancelled. All of them mean the same thing here.
    return null;
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener('abort', onAbort);
  }
}

/**
 * Lays a board reading over the last backend one.
 *
 * The board knows what it is measuring right now; it does not know the thresholds, who
 * changed them, or anything derived from them. So the measurements come from the board
 * and everything around them stays as the backend last described it, which is what the
 * screens are already built to read.
 */
export function merge(base: LiveReading, board: BoardReading): LiveReading {
  const apparent =
    board.voltageV !== null && board.currentA !== null ? board.voltageV * board.currentA : null;

  const reactive =
    apparent !== null && board.powerW !== null && apparent >= board.powerW
      ? Math.sqrt(apparent * apparent - board.powerW * board.powerW)
      : null;

  return {
    ...base,
    voltageV: board.voltageV,
    currentA: board.currentA,
    temperatureC: board.temperatureC,
    // Derived here rather than carried, so the board does not have to agree with the
    // backend about a conversion it has no reason to know.
    temperatureF: board.temperatureC === null ? null : board.temperatureC * 1.8 + 32,
    powerW: board.powerW,
    powerFactor: board.powerFactor,
    frequencyHz: board.frequencyHz,
    energyKwh: board.energyKwh,
    apparentPowerVa: apparent,
    reactivePowerVar: reactive,
    // Judged against the thresholds the backend holds, not the board's own copy: the
    // two agree in the ordinary case and the backend is the one an operator edited.
    status: apparent !== null && apparent >= base.loadThresholdVa ? 'overload' : 'normal',
    loadPercent: apparent === null ? null : (apparent / base.loadThresholdVa) * 100,
    headroomVa: apparent === null ? null : base.loadThresholdVa - apparent,
    overTemperature: board.temperatureC !== null && board.temperatureC >= base.tempThresholdC,
    // Reading it at all is proof it is there, whatever the backend last thought.
    connected: true,
    simulated: false,
    recordedAt: new Date().toISOString(),
  };
}
