import type { AuditEvent, AuditFilter } from '@/features/audit/types';
import { request } from '@/lib/api-client';
import type { Page } from '@/lib/pagination';

export function list(
  token: string,
  { limit, offset, action }: { limit: number; offset: number; action: AuditFilter },
  signal?: AbortSignal
) {
  const params = new URLSearchParams({ limit: String(limit), offset: String(offset) });
  if (action) params.set('action', `${action}.`);
  return request<Page<AuditEvent>>(`/audit?${params.toString()}`, { token, signal });
}
