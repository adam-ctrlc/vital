import type { DeviceStatus } from '@/features/device/types';
import { request } from '@/lib/api-client';

export function status(token: string, signal?: AbortSignal) {
  return request<DeviceStatus>('/device/status', { token, signal });
}

/**
 * Asks the board to open or close the relay. Admin only, server side.
 *
 * A request rather than a command: nothing here can reach the board directly, so it
 * waits for the next heartbeat. The board asks every few seconds while the relay is
 * open, so this lands in seconds rather than up to half a minute.
 */
export function relay(token: string, command: 'open' | 'close') {
  return request<{ accepted: boolean }>('/device/relay', {
    method: 'POST',
    token,
    body: { command },
  });
}
