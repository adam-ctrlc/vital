export type Status = 'normal' | 'overload';

/** Null whenever the reporting board has no PZEM to measure it. */
type MeterFields = {
  powerW: number | null;
  powerFactor: number | null;
  frequencyHz: number | null;
  energyKwh: number | null;
};

export type LiveReading = MeterFields & {
  voltageV: number | null;
  currentA: number | null;
  temperatureC: number | null;
  /** Derived server-side from temperatureC; null when there is no temperature. */
  temperatureF: number | null;
  apparentPowerVa: number | null;
  status: Status;
  loadThresholdVa: number;
  tempThresholdC: number;
  tempThresholdF: number;
  loadPercent: number | null;
  overTemperature: boolean;
  /** Q = sqrt(S^2 - P^2). Null unless real power was measured. */
  reactivePowerVar: number | null;
  /** VA left before the load threshold. Null without apparent power; negative once over. */
  headroomVa: number | null;
  /** True while the reading is a server-side placeholder rather than a board report. */
  simulated: boolean;
  /** True when a real ESP32 posted within the freshness window. */
  connected: boolean;
  /**
   * The board's address on its own network, when it is reporting one.
   *
   * Present so the app can read the board directly when it happens to share a network
   * with it, which is immediate rather than the several seconds a reading takes to
   * travel through the backend and back.
   */
  deviceIp?: string | null;
  recordedAt: string;
};

export type Reading = MeterFields & {
  id: number;
  voltageV: number | null;
  currentA: number | null;
  temperatureC: number | null;
  apparentPowerVa: number | null;
  status: Status;
  source: string;
  recordedAt: string;
};

/** Null on a day whose readings all lacked that measurement, e.g. a board with a
 *  temperature probe but no PZEM leaves both power averages null. */
export type TrendPoint = {
  day: string;
  avgPowerVa: number | null;
  maxPowerVa: number | null;
  avgTemperatureC: number | null;
  samples: number;
};
