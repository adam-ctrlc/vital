import { useColorScheme } from 'nativewind';
import { View } from 'react-native';

import { Card, CardContent } from '@/components/ui/card';
import { Text } from '@/components/ui/text';
import type { LiveReading } from '@/features/readings/types';
import { formatValue, isPlaceholder } from '@/lib/reading-format';

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
    <View className="min-w-[30%] flex-1 gap-0.5">
      <Text variant="muted" className="text-[10px] uppercase tracking-wide">
        {label}
      </Text>
      <View className="flex-row items-baseline gap-1">
        <Text
          variant={placeholder ? 'muted' : undefined}
          className="text-base font-bold leading-none"
          style={!placeholder && color ? { color } : undefined}>
          {value}
        </Text>
        {placeholder ? null : (
          <Text variant="muted" className="text-[10px]">
            {unit}
          </Text>
        )}
      </View>
      {hint ? (
        <Text variant="muted" className="text-[9px]">
          {hint}
        </Text>
      ) : null}
    </View>
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
    <Card className="py-0">
      <CardContent className="gap-3 p-4">
        <View className="flex-row flex-wrap gap-x-4 gap-y-3">
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
        </View>
      </CardContent>
    </Card>
  );
}
