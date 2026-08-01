export type SourceMode = 'simulation' | 'hardware';

export type Settings = {
  /** Raises an alert. Advisory: nothing is switched. */
  loadThresholdVa: number;
  /** Opens the relay on the board. Always above the alarm. */
  tripThresholdVa: number;
  tempThresholdC: number;
  sourceMode: SourceMode;
  updatedAt: string;
};
