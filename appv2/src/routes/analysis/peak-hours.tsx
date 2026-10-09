import { ClockIcon } from '@phosphor-icons/react';

import { AnalysisPage } from '@/components/analysis/analysis-page';
import { Heatmap } from '@/components/analysis/heatmap';
import { Panel, Stats } from '@/components/analysis/stats';
import { PEAK_HOURS_TERMS } from '@/components/analysis/terms';
import { useChartColors } from '@/components/analysis/use-chart-colors';
import type { HeatCell, Insights } from '@/features/insights/types';
import { formatMinutes, hourLabel, WEEKDAYS_SHORT } from '@/lib/units';

const WEEKDAYS = ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday'];

export default function PeakHoursScreen() {
  return <AnalysisPage icon={ClockIcon} title="Peak hours" terms={PEAK_HOURS_TERMS}>{(data) => <PeakHours data={data} />}</AnalysisPage>;
}

/** Sums one measure over the cells that share a key. */
function totals(cells: HeatCell[], key: (cell: HeatCell) => number, measure: (cell: HeatCell) => number | null) {
  const sums = new Map<number, { sum: number; weight: number }>();
  for (const cell of cells) {
    const value = measure(cell);
    if (value === null) continue;
    const entry = sums.get(key(cell)) ?? { sum: 0, weight: 0 };
    entry.sum += value * cell.samples;
    entry.weight += cell.samples;
    sums.set(key(cell), entry);
  }
  return [...sums.entries()].map(([k, { sum, weight }]) => ({ key: k, value: weight ? sum / weight : 0 }));
}

/** "5 PM to 7 PM" for a run of hours, otherwise "9 AM, 5 PM and 7 PM". */
function hourList(hours: number[]) {
  if (hours.length > 1 && hours.every((h, i) => i === 0 || h === hours[i - 1] + 1)) {
    return `${hourLabel(hours[0])} to ${hourLabel(hours[hours.length - 1])}`;
  }
  const labels = hours.map(hourLabel);
  return labels.length > 1 ? `${labels.slice(0, -1).join(', ')} and ${labels[labels.length - 1]}` : labels[0];
}

function PeakHours({ data }: { data: Insights }) {
  const colors = useChartColors();
  const cells = data.heatmap;
  const byHour = totals(cells, (c) => c.hour, (c) => c.avgVa);
  const byDay = totals(cells, (c) => c.weekday, (c) => c.avgVa);
  const overByHour = new Map<number, number>();
  for (const cell of cells) overByHour.set(cell.hour, (overByHour.get(cell.hour) ?? 0) + cell.overloadMinutes);

  const busiestHour = byHour.reduce<(typeof byHour)[number] | undefined>((a, b) => (!a || b.value > a.value ? b : a), undefined);
  const busiestDay = byDay.reduce<(typeof byDay)[number] | undefined>((a, b) => (!a || b.value > a.value ? b : a), undefined);
  const overHours = [...overByHour.entries()].filter(([, minutes]) => minutes > 0).sort((a, b) => b[1] - a[1]);
  const totalOver = [...overByHour.values()].reduce((a, b) => a + b, 0);
  const topOver = overHours
    .slice(0, 3)
    .map(([hour]) => hour)
    .sort((a, b) => a - b);

  return (
    <>
      <Stats
        items={[
          {
            label: 'Busiest hour',
            value: busiestHour ? hourLabel(busiestHour.key) : 'No data',
            detail: busiestHour ? `${busiestHour.value.toFixed(0)} VA on average` : undefined,
          },
          {
            label: 'Busiest day',
            value: busiestDay ? WEEKDAYS[busiestDay.key] : 'No data',
            detail: busiestDay ? `${busiestDay.value.toFixed(0)} VA on average` : undefined,
          },
          {
            label: 'Most time over the limit',
            value: overHours.length ? hourLabel(overHours[0][0]) : 'None',
            detail: overHours.length ? formatMinutes(overHours[0][1]) : undefined,
            tone: overHours.length ? 'danger' : undefined,
          },
          { label: 'Over the limit in all', value: formatMinutes(totalOver), tone: totalOver > 0 ? 'danger' : undefined },
        ]}
      />
      <Panel
        title="Load by hour"
        description={
          topOver.length
            ? `Overloads happen most around ${hourList(topOver)}.`
            : 'No time over the limit in this range.'
        }>
        <Heatmap cells={cells} color={colors.primary} dangerColor={colors.danger} />
      </Panel>
      <p className="text-muted-foreground px-1 text-xs">
        Each square is one hour of one weekday ({WEEKDAYS_SHORT[0]} to {WEEKDAYS_SHORT[6]}), Philippine time.
      </p>
    </>
  );
}
