export type DeviceStatus = {
  connected: boolean;
  deviceId: string | null;
  firmware: string | null;
  ipAddress: string | null;
  signalDbm: number | null;
  uptimeSeconds: number | null;
  ssid: string | null;
  lastSeenAt: string | null;
  lastSeenLabel: string | null;
  /** True while the API is serving placeholders rather than real device reports. */
  simulated: boolean;
  /**
   * The relay is open and will stay open until an admin resets it.
   *
   * The board reaches this after it runs out of reclose attempts: opening the relay
   * removes the current it judges by, so it cannot tell whether the fault is still
   * there and stops guessing.
   */
  relayLockedOut: boolean;
  /**
   * The relay's position as of the newest hardware reading, null if it has never
   * reported one.
   *
   * Distinct from the lockout: a relay can be open without being locked out, while it
   * waits out a reclose delay.
   */
  relayClosed: boolean | null;
};
