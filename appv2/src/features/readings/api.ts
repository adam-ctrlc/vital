import type { LiveReading, Reading, TrendPoint } from '@/features/readings/types';
import { request } from '@/lib/api-client';
import type { Page } from '@/lib/pagination';

export type HistoryFilters = {
  limit?: number;
  offset?: number;
  status?: string;
  source?: 'hardware' | 'simulator';
  q?: string;
  /** RFC 3339 instants: from inclusive, to exclusive. */
  from?: string;
  to?: string;
  minVa?: number;
  maxVa?: number;
  minTempC?: number;
  sort?: 'newest' | 'oldest' | 'load' | 'temperature';
};

export function latest(token: string, signal?: AbortSignal) {
  return request<LiveReading>('/readings/latest', { token, signal });
}

export function history(token: string, filters: HistoryFilters = {}, signal?: AbortSignal) {
  const params = new URLSearchParams();
  if (filters.limit !== undefined) params.set('limit', String(filters.limit));
  if (filters.offset) params.set('offset', String(filters.offset));
  if (filters.status) params.set('status', filters.status);
  if (filters.source) params.set('source', filters.source);
  if (filters.q?.trim()) params.set('q', filters.q.trim());
  if (filters.from) params.set('from', filters.from);
  if (filters.to) params.set('to', filters.to);
  if (filters.minVa !== undefined) params.set('minVa', String(filters.minVa));
  if (filters.maxVa !== undefined) params.set('maxVa', String(filters.maxVa));
  if (filters.minTempC !== undefined) params.set('minTempC', String(filters.minTempC));
  if (filters.sort && filters.sort !== 'newest') params.set('sort', filters.sort);

  return request<Page<Reading>>(`/readings?${params.toString()}`, { token, signal });
}

export function trend(token: string, days = 7, signal?: AbortSignal) {
  return request<TrendPoint[]>(`/readings/trend?days=${days}`, { token, signal });
}
