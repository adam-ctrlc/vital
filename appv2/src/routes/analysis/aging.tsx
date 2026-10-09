import { HourglassMediumIcon } from '@phosphor-icons/react';

import { AnalysisPage } from '@/components/analysis/analysis-page';
import { DayBars } from '@/components/analysis/day-bars';
import { Panel, Stats } from '@/components/analysis/stats';
import { useChartColors } from '@/components/analysis/use-chart-colors';
import { Callout } from '@/components/ui/callout';
import type { Insights } from '@/features/insights/types';
import { dateLabel, formatAgingHours, formatFactor } from '@/lib/units';

export default function AgingScreen() {
  return <AnalysisPage icon={HourglassMediumIcon} title="Transformer aging">{(data) => <Aging data={data} />}</AnalysisPage>;
}

function Aging({ data }: { data: Insights }) {
  const colors = useChartColors();
  const { aging } = data;

  return (
    <>
      <Stats
        items={[
          { label: 'Average aging rate', value: formatFactor(aging.avgAgingFactor), detail: '1\u00a0× is normal aging' },
          {
            label: 'Highest aging rate',
            value: formatFactor(aging.maxAgingFactor),
            detail: aging.maxTempC === null ? undefined : `at ${aging.maxTempC.toFixed(1)} °C`,
            tone: aging.maxAgingFactor !== null && aging.maxAgingFactor > 1 ? 'warning' : undefined,
          },
          {
            label: 'Equivalent aging',
            value: formatAgingHours(aging.equivalentHours),
            detail: `in ${aging.periodHours.toLocaleString('en-US')} h`,
          },
          {
            label: 'Life used',
            value: `${Number(aging.lifeUsedPercent.toPrecision(2))}%`,
            detail: `of a ${aging.normalLifeHours.toLocaleString('en-US')} h normal life`,
          },
        ]}
      />
      <Panel title="Aging rate per day" description="Hotter days age the insulation faster. 1&nbsp;× is normal.">
        <DayBars
          label="Aging rate per day"
          bars={aging.days.map((day) => ({
            date: day.date,
            value: day.agingFactor,
            highlight: (day.agingFactor ?? 0) > 1,
            tooltip:
              day.agingFactor === null
                ? `${dateLabel(day.date)}: no temperature readings`
                : `${dateLabel(day.date)}: ${formatFactor(day.agingFactor)}${day.maxTempC === null ? '' : `, up to ${day.maxTempC.toFixed(1)} °C`}`,
          }))}
          color={colors.primary}
          highlightColor={colors.danger}
          format={formatFactor}
        />
      </Panel>
      <Callout
        tone="info"
        title="An estimate"
        description={`Calculated with the ${aging.method} aging formula against a ${aging.referenceTempC} °C hot spot. The probe measures the transformer's surface, which runs cooler than the winding hot spot, so the real aging is somewhat higher.`}
      />
    </>
  );
}
