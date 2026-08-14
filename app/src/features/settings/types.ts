export type SourceMode = 'simulation' | 'hardware';

export type Settings = {
  /** Raises an alert. Advisory: nothing is switched. */
  loadThresholdVa: number;
  /** Opens the relay on the board. Always above the alarm. */
  tripThresholdVa: number;
  tempThresholdC: number;
  /**
   * How long the board waits with the load off before trying to close again.
   *
   * A setting rather than a firmware constant: how long a transformer should sit
   * disconnected before a retry depends on the transformer, and changing it should not
   * need a reflash. It travels to the board on its heartbeat.
   */
  recloseDelaySeconds: number;
  /**
   * How long the load must stay above the trip threshold before the relay opens.
   *
   * The counterpart to the wait above, and its opposite: this one runs while the load
   * is still connected and decides whether to cut it. It reaches the board on the same
   * heartbeat.
   */
  tripConfirmSeconds: number;
  sourceMode: SourceMode;
  updatedAt: string;
};
