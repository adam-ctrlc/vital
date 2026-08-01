import type { Settings, SourceMode } from '@/features/settings/types';
import { request } from '@/lib/api-client';

export function read(token: string) {
  return request<Settings>('/settings', { token });
}

export function update(
  token: string,
  loadThresholdVa: number,
  tripThresholdVa: number,
  tempThresholdC: number
) {
  return request<Settings>('/settings', {
    method: 'PUT',
    token,
    body: { loadThresholdVa, tripThresholdVa, tempThresholdC },
  });
}

export function setSourceMode(token: string, mode: SourceMode) {
  return request<Settings>('/settings/source', {
    method: 'PUT',
    token,
    body: { sourceMode: mode },
  });
}
