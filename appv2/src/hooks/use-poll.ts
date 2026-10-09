import { useEffect, useRef, useState } from 'react';

type PollOptions = {
  /**
   * Changing this discards the current data and refetches at once, so a filter
   * change shows a loading state instead of stale rows until the next tick.
   */
  resetKey?: string;
  /** Changing this refetches at once but keeps the current data on screen. */
  reloadKey?: string | number;
};

/// Fast heartbeat: re-runs `fetcher` on an interval and keeps the newest value.
export function usePoll<T>(
  fetcher: (signal: AbortSignal) => Promise<T>,
  intervalMs: number,
  enabled = true,
  { resetKey = '', reloadKey = '' }: PollOptions = {}
) {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<Error | null>(null);
  const saved = useRef(fetcher);
  const lastReset = useRef(resetKey);

  useEffect(() => {
    saved.current = fetcher;
  }, [fetcher]);

  useEffect(() => {
    if (!enabled) return;

    // Only a reset clears; a reload leaves the rows in place to avoid flashing
    // the whole list when a single row changes.
    if (lastReset.current !== resetKey) {
      lastReset.current = resetKey;
      setData(null);
      setError(null);
    }

    let active = true;
    let latest = 0;
    const controller = new AbortController();

    async function tick() {
      // A slow response must not clobber a fresher one: only the most recently
      // started tick is allowed to apply its result.
      const seq = ++latest;
      try {
        const result = await saved.current(controller.signal);
        if (active && seq === latest) {
          setData(result);
          setError(null);
        }
      } catch (caught) {
        if (active && seq === latest && (caught as Error).name !== 'AbortError') {
          setError(caught as Error);
        }
      }
    }

    void tick();
    const id = setInterval(() => void tick(), intervalMs);

    return () => {
      active = false;
      controller.abort();
      clearInterval(id);
    };
  }, [intervalMs, enabled, resetKey, reloadKey]);

  return { data, error };
}
