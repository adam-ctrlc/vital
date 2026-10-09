import type { Alert, AlertKind } from '@/features/alerts/types';
import { request } from '@/lib/api-client';
import type { Page } from '@/lib/pagination';

export type AlertFilters = {
  activeOnly: boolean;
  q?: string;
  kind?: AlertKind;
  limit?: number;
  offset?: number;
};

export function list(token: string, filters: AlertFilters, signal?: AbortSignal) {
  const params = new URLSearchParams({ active: String(filters.activeOnly) });
  if (filters.q?.trim()) params.set('q', filters.q.trim());
  if (filters.kind) params.set('kind', filters.kind);
  if (filters.limit !== undefined) params.set('limit', String(filters.limit));
  if (filters.offset) params.set('offset', String(filters.offset));

  return request<Page<Alert>>(`/alerts?${params.toString()}`, { token, signal });
}

/** Unacknowledged count only; asks for the smallest window since only `total` is used. */
export function activeCount(token: string, signal?: AbortSignal) {
  return request<Page<Alert>>('/alerts?active=true&limit=1', { token, signal }).then(
    (page) => page.total
  );
}

export function acknowledge(token: string, id: number) {
  return request<Alert>(`/alerts/${id}/ack`, { method: 'POST', token });
}
