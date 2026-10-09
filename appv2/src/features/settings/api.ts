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

/** Sends every stored field back with `patch` applied, since the endpoint takes them together. */
export function updateWith(
  token: string,
  current: Settings,
  patch: Partial<Pick<Settings, 'energyRatePerKwh' | 'nominalVoltageV'>>
) {
  return request<Settings>('/settings', {
    method: 'PUT',
    token,
    body: {
      loadThresholdVa: current.loadThresholdVa,
      tripThresholdVa: current.tripThresholdVa,
      tempThresholdC: current.tempThresholdC,
      recloseDelaySeconds: current.recloseDelaySeconds,
      tripConfirmSeconds: current.tripConfirmSeconds,
      ...patch,
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
