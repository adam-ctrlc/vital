/**
 * GET /insights?from=&to=&source= (admin). Dates are Manila days (YYYY-MM-DD), both ends
 * included, at most 366 days; source is hardware (the default), simulator or all.
 */
export type Insights = {
  from: string;
  to: string;
  source: 'hardware' | 'simulator' | 'all';
  samples: number;
  energy: {
    ratePerKwh: number;
    totalKwh: number;
    totalCost: number;
    peakVa: number | null;
    peakAt: string | null;
    overloadMinutes: number;
    days: EnergyDay[];
  };
  /** Weekday 0 is Monday, hours 0 to 23, Manila time. Hours with no readings are left out. */
  heatmap: HeatCell[];
  powerQuality: {
    nominalVoltageV: number;
    minVoltageV: number | null;
    avgVoltageV: number | null;
    maxVoltageV: number | null;
    sagMinutes: number;
    swellMinutes: number;
    events: VoltageEvent[];
    avgPowerFactor: number | null;
    lowPowerFactorMinutes: number;
    correction: Correction | null;
  };
  aging: {
    method: string;
    referenceTempC: number;
    normalLifeHours: number;
    avgAgingFactor: number | null;
    maxAgingFactor: number | null;
    avgTempC: number | null;
    maxTempC: number | null;
    equivalentHours: number;
    periodHours: number;
    lifeUsedPercent: number;
    days: AgingDay[];
  };
  alerts: {
    total: number;
    overload: number;
    temperature: number;
    unacknowledged: number;
    medianResponseSeconds: number | null;
    byPerson: PersonResponse[];
    rows: AlertRow[];
  };
};

export type EnergyDay = {
  date: string;
  kwh: number;
  cost: number;
  avgVa: number | null;
  peakVa: number | null;
  overloadMinutes: number;
  samples: number;
};

export type HeatCell = {
  weekday: number;
  hour: number;
  avgVa: number | null;
  maxVa: number | null;
  overloadMinutes: number;
  samples: number;
};

export type VoltageEvent = {
  at: string;
  kind: 'sag' | 'swell';
  voltageV: number;
  durationSeconds: number;
};

export type Correction = {
  targetPowerFactor: number;
  basisPowerW: number;
  basisPowerFactor: number;
  kvar: number;
  capacitorUf: number;
};

export type AgingDay = {
  date: string;
  agingFactor: number | null;
  maxTempC: number | null;
};

export type PersonResponse = {
  userId: string;
  name: string;
  count: number;
  medianResponseSeconds: number | null;
};

export type AlertRow = {
  id: number;
  kind: 'overload' | 'temperature';
  value: number;
  threshold: number;
  createdAt: string;
  acknowledgedAt: string | null;
  responseMs: number | null;
  acknowledgedByName: string | null;
};

/** In the app's own state; null means both feeds. */
export type InsightSource = 'hardware' | 'simulator' | null;
