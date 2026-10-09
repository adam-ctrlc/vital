import { FileCsvIcon, FilePdfIcon, FileTextIcon } from '@phosphor-icons/react';
import { useState } from 'react';

import { AnalysisPage } from '@/components/analysis/analysis-page';
import { Panel, Stats } from '@/components/analysis/stats';
import { Button } from '@/components/ui/button';
import { Callout } from '@/components/ui/callout';
import { useAuth } from '@/features/auth/context';
import * as insightsApi from '@/features/insights/api';
import { describeRange, toInsightQuery, type AnalysisRange } from '@/features/insights/range';
import type { Insights } from '@/features/insights/types';
import { useAppearance } from '@/lib/appearance';
import { IS_NATIVE } from '@/lib/platform';
import { saveFile } from '@/lib/save-file';
import { formatAgingHours, formatFactor, formatMinutes, formatSeconds, peso } from '@/lib/units';

const SOURCE_LABEL = { hardware: 'Sensor readings', simulator: 'Simulated readings', all: 'All readings' };

export default function ReportsScreen() {
  return (
    <AnalysisPage icon={FileTextIcon} title="Reports">
      {(data, { range }) => <Report data={data} range={range} />}
    </AnalysisPage>
  );
}

function Report({ data, range }: { data: Insights; range: AnalysisRange }) {
  const { token } = useAuth();
  const { primary } = useAppearance();
  const [busy, setBusy] = useState<'pdf' | 'csv' | null>(null);
  const [error, setError] = useState<string | null>(null);
  const { energy, powerQuality: pq, aging, alerts } = data;
  const sourceLabel = SOURCE_LABEL[range.source ?? 'all'];

  async function run(kind: 'pdf' | 'csv', task: () => Promise<void>) {
    setBusy(kind);
    setError(null);
    try {
      await task();
    } catch (caught) {
      setError((caught as Error).message);
    } finally {
      setBusy(null);
    }
  }

  const downloadPdf = () =>
    run('pdf', async () => {
      const { buildReportPdf } = await import('@/features/reports/pdf');
      const bytes = buildReportPdf(data, {
        rangeLabel: describeRange(range),
        sourceLabel,
        generatedAt: new Date(),
        accent: primary.hex,
      });
      await saveFile({ name: `vital-report-${data.from}-to-${data.to}.pdf`, mimeType: 'application/pdf', bytes });
    });

  const downloadCsv = () =>
    run('csv', async () => {
      const text = await insightsApi.exportCsv(token ?? '', toInsightQuery(range));
      await saveFile({ name: `vital-readings-${data.from}-to-${data.to}.csv`, mimeType: 'text/csv', text });
    });

  return (
    <>
      <Panel title="Download" description={`${describeRange(range)} · ${sourceLabel}`}>
        <div className="grid gap-2 sm:grid-cols-2">
          <Button onClick={() => void downloadPdf()} disabled={busy !== null}>
            <FilePdfIcon weight="bold" aria-hidden="true" />
            {busy === 'pdf' ? 'Preparing…' : 'Download PDF'}
          </Button>
          <Button variant="outline" onClick={() => void downloadCsv()} disabled={busy !== null}>
            <FileCsvIcon weight="bold" aria-hidden="true" />
            {busy === 'csv' ? 'Preparing…' : 'Download CSV'}
          </Button>
        </div>
        <p className="text-muted-foreground text-xs">
          {IS_NATIVE
            ? 'Opens the share sheet, to save it to Files or Drive or send it.'
            : 'The PDF is the summary below with every alert; the CSV has every reading.'}
        </p>
        {error ? <Callout tone="destructive" title="Could not prepare the file" description={error} /> : null}
      </Panel>

      <Stats
        items={[
          { label: 'Energy used', value: `${energy.totalKwh.toFixed(3)} kWh`, detail: peso(energy.totalCost) },
          { label: 'Peak load', value: energy.peakVa === null ? 'No data' : `${energy.peakVa.toFixed(0)} VA` },
          { label: 'Over the limit', value: formatMinutes(energy.overloadMinutes), tone: energy.overloadMinutes > 0 ? 'danger' : undefined },
          {
            label: 'Alerts',
            value: String(alerts.total),
            detail:
              alerts.medianResponseSeconds === null
                ? `${alerts.unacknowledged} not acknowledged`
                : `typically answered in ${formatSeconds(alerts.medianResponseSeconds)}`,
          },
        ]}
      />

      <Panel title="In the report">
        <dl className="grid gap-x-4 gap-y-2 text-sm sm:grid-cols-[10rem_1fr]">
          <dt className="text-muted-foreground">Voltage</dt>
          <dd>
            {pq.minVoltageV === null || pq.maxVoltageV === null
              ? 'No data'
              : `${pq.minVoltageV.toFixed(1)} to ${pq.maxVoltageV.toFixed(1)} V, nominal ${pq.nominalVoltageV} V`}
          </dd>
          <dt className="text-muted-foreground">Power factor</dt>
          <dd>{pq.avgPowerFactor === null ? 'No data' : `${pq.avgPowerFactor.toFixed(2)} on average`}</dd>
          <dt className="text-muted-foreground">Transformer aging</dt>
          <dd>
            {formatFactor(aging.avgAgingFactor)} average rate, {formatAgingHours(aging.equivalentHours)} of aging
          </dd>
          <dt className="text-muted-foreground">Days with readings</dt>
          <dd>
            {energy.days.filter((day) => day.samples > 0).length} of {energy.days.length}
          </dd>
        </dl>
      </Panel>

      {alerts.byPerson.length > 0 ? (
        <Panel title="Response times" flush>
          <div className="-mt-1 overflow-x-auto">
            <table className="w-full whitespace-nowrap text-xs tabular-nums">
              <thead className="text-muted-foreground text-[11px]">
                <tr className="bg-muted border-y">
                  <th scope="col" className="px-4 py-2.5 text-left font-medium">Person</th>
                  <th scope="col" className="px-3 py-2.5 text-right font-medium">Alerts</th>
                  <th scope="col" className="px-4 py-2.5 text-right font-medium">Typical response</th>
                </tr>
              </thead>
              <tbody className="divide-y">
                {alerts.byPerson.map((person) => (
                  <tr key={person.userId}>
                    <th scope="row" className="px-4 py-2.5 text-left font-medium">{person.name}</th>
                    <td className="px-3 py-2.5 text-right">{person.count}</td>
                    <td className="px-4 py-2.5 text-right">
                      {person.medianResponseSeconds === null ? '—' : formatSeconds(person.medianResponseSeconds)}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </Panel>
      ) : null}
    </>
  );
}
