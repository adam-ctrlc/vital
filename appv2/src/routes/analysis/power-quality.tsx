import { PencilSimpleIcon, PlugIcon, WaveSineIcon } from '@phosphor-icons/react';
import { useEffect, useState } from 'react';

import { AnalysisPage } from '@/components/analysis/analysis-page';
import { NumberSheet } from '@/components/analysis/number-sheet';
import { Panel, Stats } from '@/components/analysis/stats';
import { useChartColors } from '@/components/analysis/use-chart-colors';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Pager } from '@/components/ui/pager';
import { useAuth } from '@/features/auth/context';
import type { Insights } from '@/features/insights/types';
import * as settingsApi from '@/features/settings/api';
import type { Settings } from '@/features/settings/types';
import { formatShortDateTime } from '@/lib/datetime';
import { formatMinutes, formatSeconds } from '@/lib/units';

const EVENTS_PER_PAGE = 5;

export default function PowerQualityScreen() {
  return (
    <AnalysisPage icon={WaveSineIcon} title="Power quality">
      {(data, { reload }) => <PowerQuality data={data} reload={reload} />}
    </AnalysisPage>
  );
}

function percentOf(value: number | null, nominal: number) {
  return value === null ? undefined : `${((value / nominal) * 100).toFixed(0)}% of nominal`;
}

/** Where min, average and max sit on a scale around nominal, with the ±10% band shaded. */
function VoltageScale({ data, color }: { data: Insights; color: string }) {
  const { minVoltageV: minV, avgVoltageV: avgV, maxVoltageV: maxV, nominalVoltageV: nominal } = data.powerQuality;
  const low = Math.min(minV ?? nominal, nominal * 0.8);
  const high = Math.max(maxV ?? nominal, nominal * 1.2);
  const at = (v: number) => `${((v - low) / (high - low)) * 100}%`;

  return (
    <div className="space-y-2 pt-2">
      <div className="bg-muted relative h-2.5 rounded-full">
        <div
          className="absolute inset-y-0 rounded-full bg-emerald-500/25"
          style={{ left: at(nominal * 0.9), right: `calc(100% - ${at(nominal * 1.1)})` }}
        />
        {minV !== null && maxV !== null ? (
          <div
            className="absolute inset-y-[3px] rounded-full"
            style={{ left: at(minV), right: `calc(100% - ${at(maxV)})`, backgroundColor: color }}
          />
        ) : null}
        {avgV !== null ? (
          <div className="bg-foreground absolute -top-1 h-[18px] w-0.5 rounded-full" style={{ left: at(avgV) }} />
        ) : null}
      </div>
      <div className="text-muted-foreground flex justify-between text-[11px] tabular-nums">
        <span>{low.toFixed(0)} V</span>
        <span>Normal band {(nominal * 0.9).toFixed(0)}–{(nominal * 1.1).toFixed(0)} V</span>
        <span>{high.toFixed(0)} V</span>
      </div>
    </div>
  );
}

function PowerQuality({ data, reload }: { data: Insights; reload: () => void }) {
  const { token } = useAuth();
  const colors = useChartColors();
  const [settings, setSettings] = useState<Settings | null>(null);
  const [editing, setEditing] = useState(false);
  const [eventsOffset, setEventsOffset] = useState(0);
  const pq = data.powerQuality;
  const events = pq.events.slice(eventsOffset, eventsOffset + EVENTS_PER_PAGE);
  const nominal = pq.nominalVoltageV;
  const v = (value: number | null) => (value === null ? 'No data' : `${value.toFixed(1)} V`);

  useEffect(() => setEventsOffset(0), [data]);

  useEffect(() => {
    if (token) settingsApi.read(token).then(setSettings).catch(() => undefined);
  }, [token]);

  return (
    <>
      <Stats
        items={[
          { label: 'Lowest voltage', value: v(pq.minVoltageV), detail: percentOf(pq.minVoltageV, nominal), tone: pq.sagMinutes > 0 ? 'warning' : undefined },
          { label: 'Average voltage', value: v(pq.avgVoltageV), detail: percentOf(pq.avgVoltageV, nominal) },
          { label: 'Highest voltage', value: v(pq.maxVoltageV), detail: percentOf(pq.maxVoltageV, nominal), tone: pq.swellMinutes > 0 ? 'warning' : undefined },
          {
            label: 'Average power factor',
            value: pq.avgPowerFactor === null ? 'No data' : pq.avgPowerFactor.toFixed(2),
            tone: pq.avgPowerFactor !== null && pq.avgPowerFactor < 0.85 ? 'warning' : undefined,
          },
        ]}
      />

      <Panel
        title="Voltage"
        description={`Nominal ${nominal} V. Sags are below 90% of it, swells above 110%.`}
        aside={
          <Button variant="outline" size="sm" disabled={!settings} onClick={() => setEditing(true)}>
            <PencilSimpleIcon weight="bold" aria-hidden="true" />
            Edit
          </Button>
        }>
        <VoltageScale data={data} color={colors.primary} />
        <p className="text-sm">
          {pq.sagMinutes === 0 && pq.swellMinutes === 0
            ? 'The voltage stayed in the normal band.'
            : `Below the band for ${formatMinutes(pq.sagMinutes)}, above it for ${formatMinutes(pq.swellMinutes)}.`}
        </p>
      </Panel>

      {pq.events.length > 0 ? (
        <>
          <Panel title="Worst events" flush>
            <ul className="divide-y border-t">
              {events.map((event) => (
                <li key={`${event.at}-${event.kind}`} className="flex items-center gap-3 px-4 py-3 text-sm">
                  <Badge
                    variant={event.kind === 'sag' ? 'secondary' : 'destructive'}
                    className={event.kind === 'sag' ? 'bg-amber-500 text-white' : undefined}>{event.kind === 'sag' ? 'Sag' : 'Swell'}</Badge>
                  <span className="min-w-0 flex-1">
                    <span className="font-semibold tabular-nums">{event.voltageV.toFixed(1)} V</span>
                    <span className="text-muted-foreground"> for {formatSeconds(event.durationSeconds)}</span>
                  </span>
                  <time dateTime={event.at} className="text-muted-foreground shrink-0 text-xs">
                    {formatShortDateTime(event.at)}
                  </time>
                </li>
              ))}
            </ul>
          </Panel>
          <Pager
            total={pq.events.length}
            limit={EVENTS_PER_PAGE}
            offset={eventsOffset}
            onOffsetChange={setEventsOffset}
            noun="event"
          />
        </>
      ) : null}

      <Panel title="Power factor" description="How much of the current does useful work. 1.00 is ideal; under 0.85 is low.">
        <p className="text-sm">
          {pq.avgPowerFactor === null
            ? 'No power factor readings in this range.'
            : `Averaged ${pq.avgPowerFactor.toFixed(2)}, and was low for ${formatMinutes(pq.lowPowerFactorMinutes)} while the load was on.`}
        </p>
        {pq.correction ? (
          <div className="bg-accent flex gap-3 rounded-lg p-3 text-sm">
            <PlugIcon size={18} weight="bold" className="mt-0.5 shrink-0" color={colors.primary} aria-hidden="true" />
            <p>
              To raise it from {pq.correction.basisPowerFactor.toFixed(2)} to {pq.correction.targetPowerFactor.toFixed(2)} at the
              average load of {pq.correction.basisPowerW.toFixed(0)} W, add about{' '}
              <strong>{pq.correction.kvar.toFixed(3)} kvar</strong> of capacitance, roughly a{' '}
              <strong>{pq.correction.capacitorUf.toFixed(1)} µF</strong> capacitor across the {nominal} V supply.
            </p>
          </div>
        ) : pq.avgPowerFactor !== null ? (
          <p className="text-muted-foreground text-sm">No correction needed.</p>
        ) : null}
      </Panel>

      {settings ? (
        <NumberSheet
          visible={editing}
          title="Nominal voltage"
          label="The supply's rated voltage"
          icon={WaveSineIcon}
          iconColor={colors.primary}
          unit="V"
          value={nominal}
          min={50}
          max={500}
          onSave={async (value) => {
            setSettings(await settingsApi.updateWith(token ?? '', settings, { nominalVoltageV: value }));
            reload();
          }}
          onClose={() => setEditing(false)}
        />
      ) : null}
    </>
  );
}
