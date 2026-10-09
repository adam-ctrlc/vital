import type { Insights, InsightSource } from '@/features/insights/types';
import { API_URL, ApiError, request } from '@/lib/api-client';

export type InsightQuery = {
  /** Manila dates, YYYY-MM-DD, both included. Left out, the API uses the last 7 days. */
  from?: string;
  to?: string;
  source: InsightSource;
};

function params({ from, to, source }: InsightQuery) {
  const search = new URLSearchParams({ source: source ?? 'all' });
  if (from) search.set('from', from);
  if (to) search.set('to', to);
  return search.toString();
}

export function read(token: string, query: InsightQuery, signal?: AbortSignal) {
  return request<Insights>(`/insights?${params(query)}`, { token, signal });
}

/** GET /readings/export: every reading in the range as CSV. */
export async function exportCsv(token: string, query: InsightQuery): Promise<string> {
  const response = await fetch(`${API_URL}/readings/export?${params(query)}`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  const text = await response.text();
  if (!response.ok) throw new ApiError(response.status, text.trim() || `request failed with ${response.status}`);
  return text;
}
