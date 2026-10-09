import { formatValue, formatValueWithUnit } from '@/lib/reading-format';
import { cn } from '@/lib/utils';

/** The meter fields a reading or an alert's trigger reading can carry. */
export type Measurements = {
  voltageV?: number | null;
  currentA?: number | null;
  apparentPowerVa?: number | null;
  powerW?: number | null;
  powerFactor?: number | null;
  frequencyHz?: number | null;
  energyKwh?: number | null;
  temperatureC?: number | null;
};

/** One line of the readings that matter most, for a collapsed row. */
export function keyReadings(m: Measurements): string {
  return [
    formatValueWithUnit(m.voltageV ?? null, 1, 'V'),
    formatValueWithUnit(m.currentA ?? null, 2, 'A'),
    formatValueWithUnit(m.temperatureC ?? null, 1, '°C'),
  ].join(' · ');
}

/**
 * Every measurement, in three even columns so they line up from one row to the next
 * rather than shifting with the length of each value.
 */
export function MetricGrid({ m, className }: { m: Measurements; className?: string }) {
  const items = [
    { label: 'Voltage', value: formatValueWithUnit(m.voltageV ?? null, 1, 'V') },
    { label: 'Current', value: formatValueWithUnit(m.currentA ?? null, 2, 'A') },
    { label: 'Apparent', value: formatValueWithUnit(m.apparentPowerVa ?? null, 0, 'VA') },
    { label: 'Real power', value: formatValueWithUnit(m.powerW ?? null, 0, 'W') },
    { label: 'Power factor', value: formatValue(m.powerFactor ?? null, 2) },
    { label: 'Frequency', value: formatValueWithUnit(m.frequencyHz ?? null, 2, 'Hz') },
    { label: 'Energy', value: formatValueWithUnit(m.energyKwh ?? null, 4, 'kWh') },
    { label: 'Temperature', value: formatValueWithUnit(m.temperatureC ?? null, 1, '°C') },
  ];

  return (
    <dl className={cn('grid grid-cols-3 gap-x-3 gap-y-2', className)}>
      {items.map((item) => (
        <div key={item.label} className="min-w-0">
          <dt className="text-muted-foreground text-[10px] uppercase tracking-wide">{item.label}</dt>
          <dd className="text-xs font-medium tabular-nums">{item.value}</dd>
        </div>
      ))}
    </dl>
  );
}
