import type { Settings, SourceMode } from '@/features/settings/types';
import { request } from '@/lib/api-client';

export function read(token: string) {
  return request<Settings>('/settings', { token });
}

/**
 * The endpoint takes every field together, so callers changing one send the rest back
 * unchanged. `tripConfirmSeconds` is optional on the wire: the server leaves the stored
 * value alone when it is absent, which is what keeps an older build from resetting it.
 */
export function update(
  token: string,
  loadThresholdVa: number,
  tripThresholdVa: number,
  tempThresholdC: number,
  recloseDelaySeconds: number,
  tripConfirmSeconds?: number
) {
  return request<Settings>('/settings', {
    method: 'PUT',
    token,
    body: {
      loadThresholdVa,
      tripThresholdVa,
      tempThresholdC,
      recloseDelaySeconds,
      ...(tripConfirmSeconds === undefined ? {} : { tripConfirmSeconds }),
    },
  });
}

export function setSourceMode(token: string, mode: SourceMode) {
  return request<Settings>('/settings/source', {
    method: 'PUT',
    token,
    body: { sourceMode: mode },
  });
}
