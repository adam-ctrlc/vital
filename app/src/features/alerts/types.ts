export type AlertKind = 'overload' | 'temperature';

/**
 * The reading that triggered an alert, joined server side.
 *
 * Absent on the acknowledge response, which returns the alert row alone, so callers
 * must merge rather than replace or the measurements vanish from an acknowledged card.
 */
type TriggerReading = {
  voltageV?: number | null;
  currentA?: number | null;
  temperatureC?: number | null;
  apparentPowerVa?: number | null;
  powerW?: number | null;
  powerFactor?: number | null;
  frequencyHz?: number | null;
  energyKwh?: number | null;
};

export type Alert = TriggerReading & {
  id: number;
  readingId: number | null;
  kind: AlertKind;
  message: string;
  value: number;
  threshold: number;
  createdAt: string;
  acknowledgedAt: string | null;
  acknowledgedBy: string | null;
  responseMs: number | null;
};
