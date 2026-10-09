import { CoinsIcon, LightningIcon, PencilSimpleIcon } from '@phosphor-icons/react';
import { useEffect, useState } from 'react';

import { AnalysisPage } from '@/components/analysis/analysis-page';
import { DayBars } from '@/components/analysis/day-bars';
import { NumberSheet } from '@/components/analysis/number-sheet';
import { Panel, Stats } from '@/components/analysis/stats';
import { useChartColors } from '@/components/analysis/use-chart-colors';
import { Button } from '@/components/ui/button';
import { Pager } from '@/components/ui/pager';
import { useAuth } from '@/features/auth/context';
import type { Insights } from '@/features/insights/types';
import * as settingsApi from '@/features/settings/api';
import type { Settings } from '@/features/settings/types';
import { formatShortDateTime } from '@/lib/datetime';
import { dateLabel, formatMinutes, peso } from '@/lib/units';

export default function EnergyScreen() {
  return (
    <AnalysisPage icon={LightningIcon} title="Energy & cost">
      {(data, { reload }) => <Energy data={data} reload={reload} />}
    </AnalysisPage>
  );
}

const DAYS_PER_PAGE = 10;

function Energy({ data, reload }: { data: Insights; reload: () => void }) {
  const { token } = useAuth();
  const colors = useChartColors();
  const [settings, setSettings] = useState<Settings | null>(null);
  const [editing, setEditing] = useState(false);
  const { energy } = data;
  const readDays = energy.days.filter((day) => day.samples > 0).reverse();
  const [daysOffset, setDaysOffset] = useState(0);
  const pageDays = readDays.slice(daysOffset, daysOffset + DAYS_PER_PAGE);

  useEffect(() => setDaysOffset(0), [data]);

  useEffect(() => {
    if (token) settingsApi.read(token).then(setSettings).catch(() => undefined);
  }, [token]);

  return (
    <>
      <Stats
        items={[
          { label: 'Energy used', value: `${energy.totalKwh.toFixed(3)} kWh` },
          { label: 'Estimated cost', value: peso(energy.totalCost) },
          {
            label: 'Peak load',
            value: energy.peakVa === null ? 'No data' : `${energy.peakVa.toFixed(0)} VA`,
            detail: energy.peakAt ? formatShortDateTime(energy.peakAt) : undefined,
          },
          {
            label: 'Over the limit',
            value: formatMinutes(energy.overloadMinutes),
            tone: energy.overloadMinutes > 0 ? 'danger' : undefined,
          },
        ]}
      />

      <Panel
        title="Electricity rate"
        description={`${peso(energy.ratePerKwh)} per kWh, used for every cost on these pages.`}
        aside={
          <Button variant="outline" size="sm" disabled={!settings} onClick={() => setEditing(true)}>
            <PencilSimpleIcon weight="bold" aria-hidden="true" />
            Edit
          </Button>
        }>
        {null}
      </Panel>

      <Panel title="Energy per day" description="Days with a red bar went over the limit.">
        <DayBars
          label="Energy used per day"
          bars={energy.days.map((day) => ({
            date: day.date,
            value: day.samples > 0 ? day.kwh : null,
            highlight: day.overloadMinutes > 0,
            tooltip: day.samples > 0 ? `${dateLabel(day.date)}: ${day.kwh.toFixed(3)} kWh, ${peso(day.cost)}` : `${dateLabel(day.date)}: no readings`,
          }))}
          color={colors.primary}
          highlightColor={colors.danger}
          format={(value) => value.toFixed(2)}
        />
      </Panel>

      <Panel title="By day" description="Days with readings." flush>
        <div className="-mt-1 overflow-x-auto">
          <table className="w-full min-w-[520px] whitespace-nowrap text-xs tabular-nums">
            <thead className="text-muted-foreground text-[11px]">
              <tr className="bg-muted border-y">
                <th scope="col" className="px-4 py-2.5 text-left font-medium">Day</th>
                <th scope="col" className="px-3 py-2.5 text-right font-medium">kWh</th>
                <th scope="col" className="px-3 py-2.5 text-right font-medium">Cost</th>
                <th scope="col" className="px-3 py-2.5 text-right font-medium">Average VA</th>
                <th scope="col" className="px-3 py-2.5 text-right font-medium">Peak VA</th>
                <th scope="col" className="px-4 py-2.5 text-right font-medium">Over the limit</th>
              </tr>
            </thead>
            <tbody className="divide-y">
              {pageDays.map((day) => (
                <tr key={day.date}>
                  <th scope="row" className="whitespace-nowrap px-4 py-2.5 text-left font-medium">
                    {dateLabel(day.date)}
                  </th>
                  <td className="px-3 py-2.5 text-right">{day.kwh.toFixed(3)}</td>
                  <td className="text-muted-foreground px-3 py-2.5 text-right">{peso(day.cost)}</td>
                  <td className="text-muted-foreground px-3 py-2.5 text-right">{day.avgVa?.toFixed(0) ?? '—'}</td>
                  <td className="text-muted-foreground px-3 py-2.5 text-right">{day.peakVa?.toFixed(0) ?? '—'}</td>
                  <td className={day.overloadMinutes > 0 ? 'text-destructive px-4 py-2.5 text-right font-medium' : 'text-muted-foreground px-4 py-2.5 text-right'}>
                    {day.overloadMinutes > 0 ? formatMinutes(day.overloadMinutes) : '—'}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </Panel>
      <Pager total={readDays.length} limit={DAYS_PER_PAGE} offset={daysOffset} onOffsetChange={setDaysOffset} noun="day" />

      {settings ? (
        <NumberSheet
          visible={editing}
          title="Electricity rate"
          label="Pesos per kWh"
          icon={CoinsIcon}
          iconColor={colors.primary}
          unit="₱/kWh"
          value={energy.ratePerKwh}
          min={0}
          max={1000}
          onSave={async (value) => {
            setSettings(await settingsApi.updateWith(token ?? '', settings, { energyRatePerKwh: value }));
            reload();
          }}
          onClose={() => setEditing(false)}
        />
      ) : null}
    </>
  );
}
