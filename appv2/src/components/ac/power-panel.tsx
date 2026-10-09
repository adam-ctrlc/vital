import { Card } from '@/components/ui/card';
import type { LiveReading } from '@/features/readings/types';
import { useColorScheme } from '@/lib/appearance';
import { formatValue, isPlaceholder } from '@/lib/reading-format';
import { cn } from '@/lib/utils';

type PowerPanelProps = {
  data: LiveReading | null;
  accent: string;
};

function Stat({
  label,
  value,
  unit,
  hint,
  color,
}: {
  label: string;
  value: string;
  unit: string;
  hint?: string;
  color?: string;
}) {
  const placeholder = isPlaceholder(value);
  return (
    <div className="flex min-w-[30%] flex-1 flex-col gap-0.5">
      <dt className="text-muted-foreground text-[10px] uppercase tracking-wide">{label}</dt>
      <dd className="flex items-baseline gap-1">
        <span
          className={cn('text-base font-bold leading-none tabular-nums', placeholder && 'text-muted-foreground')}
          style={!placeholder && color ? { color } : undefined}>
          {value}
        </span>
        {placeholder ? null : <span className="text-muted-foreground text-[10px]">{unit}</span>}
      </dd>
      {hint ? <dd className="text-muted-foreground text-[9px]">{hint}</dd> : null}
    </div>
  );
}

/**
 * The metering side of the reading: real and reactive power, power factor,
 * frequency and energy. All measured by the PZEM, not derived from VA.
 */
export function PowerPanel({ data, accent }: PowerPanelProps) {
  const { colorScheme } = useColorScheme();
  const danger = colorScheme === 'dark' ? '#f87171' : '#dc2626';

  const headroom = data ? data.headroomVa : undefined;
  const tight = headroom != null && headroom <= 0;
  const pf = data?.powerFactor ?? null;
  // Below ~0.85 a load study starts flagging poor power factor.
  const poorPf = pf !== null && pf < 0.85;

  return (
    <Card className="p-4">
      <dl className="flex flex-wrap gap-x-4 gap-y-3">
        <Stat
          label="Real power"
          value={formatValue(data ? data.powerW : undefined, 0)}
          unit="W"
          hint="Actually consumed"
          color={accent}
        />
        <Stat
          label="Reactive"
          value={formatValue(data ? data.reactivePowerVar : undefined, 0)}
          unit="VAR"
          hint="Circulating"
        />
        <Stat
          label="Power factor"
          value={formatValue(data ? data.powerFactor : undefined, 2)}
          unit=""
          hint={poorPf ? 'Poor' : 'Healthy'}
          color={poorPf ? danger : undefined}
        />
        <Stat
          label="Frequency"
          value={formatValue(data ? data.frequencyHz : undefined, 2)}
          unit="Hz"
          hint="Grid"
        />
        <Stat
          label="Energy"
          // Four decimals. The meter itself resolves three, so the last digit only
          // carries anything in simulator mode, but a coarser format left a kilowatt
          // of load sitting on 0.0 for minutes and reading as a broken sensor.
          value={formatValue(data ? data.energyKwh : undefined, 4)}
          unit="kWh"
          hint="Meter total"
        />
        <Stat
          label="Temperature"
          value={formatValue(data ? data.temperatureF : undefined, 1)}
          unit="°F"
          hint={
            data && data.temperatureC !== null
              ? `${data.temperatureC.toFixed(1)} °C`
              : 'Same reading'
          }
        />
        <Stat
          label="Headroom"
          value={headroom == null ? formatValue(headroom, 0) : Math.abs(headroom).toFixed(0)}
          unit="VA"
          hint={tight ? 'Over limit' : 'Before limit'}
          color={tight ? danger : undefined}
        />
      </dl>
    </Card>
  );
}
