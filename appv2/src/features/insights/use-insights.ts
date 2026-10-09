import { useCallback, useEffect, useMemo, useState } from 'react';

import { useAuth } from '@/features/auth/context';
import * as insightsApi from '@/features/insights/api';
import { toInsightQuery, type AnalysisRange } from '@/features/insights/range';
import type { Insights } from '@/features/insights/types';

export function useInsights(range: AnalysisRange) {
  const { token } = useAuth();
  const [data, setData] = useState<Insights | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [attempt, setAttempt] = useState(0);
  const query = useMemo(() => toInsightQuery(range), [range]);

  useEffect(() => {
    if (!token) return;
    const controller = new AbortController();
    setLoading(true);
    insightsApi
      .read(token, query, controller.signal)
      .then((next) => {
        setData(next);
        setError(null);
      })
      .catch((caught: Error) => {
        if (caught.name !== 'AbortError') setError(caught.message);
      })
      .finally(() => {
        if (!controller.signal.aborted) setLoading(false);
      });
    return () => controller.abort();
  }, [token, query, attempt]);

  const reload = useCallback(() => setAttempt((n) => n + 1), []);
  return { data, error, loading, reload, query };
}
