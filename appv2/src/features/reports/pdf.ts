import { jsPDF } from 'jspdf';
import { autoTable } from 'jspdf-autotable';

import type { Insights } from '@/features/insights/types';
import { formatDateTime, formatShortDateTime } from '@/lib/datetime';
import { dateLabel, formatAgingHours, formatFactor, formatMinutes, formatSeconds } from '@/lib/units';

// The built-in PDF fonts have no peso sign.
const php = (value: number) =>
  `PHP ${value.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

function rgb(hex: string): [number, number, number] {
  const n = Number.parseInt(hex.slice(1), 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

export type ReportMeta = { rangeLabel: string; sourceLabel: string; generatedAt: Date; accent: string };

export function buildReportPdf(data: Insights, meta: ReportMeta): ArrayBuffer {
  const doc = new jsPDF({ unit: 'pt', format: 'a4' });
  const margin = 40;
  const accent = rgb(meta.accent);
  const { energy, powerQuality: pq, aging, alerts } = data;
  let y = margin;

  const section = (title: string) => {
    const last = (doc as jsPDF & { lastAutoTable?: { finalY: number } }).lastAutoTable;
    y = (last ? last.finalY : y) + 26;
    if (y > 760) {
      doc.addPage();
      y = margin;
    }
    doc.setFont('helvetica', 'bold').setFontSize(12).setTextColor(20).text(title, margin, y);
    y += 8;
  };

  // `right`: the columns holding numbers.
  const table = (head: string[], body: (string | number)[][], right: number[]) =>
    autoTable(doc, {
      startY: y,
      head: [head],
      body,
      margin: { left: margin, right: margin },
      styles: { font: 'helvetica', fontSize: 8.5, cellPadding: 4, textColor: 40 },
      headStyles: { fillColor: accent, textColor: 255, fontStyle: 'bold' },
      alternateRowStyles: { fillColor: [246, 247, 249] },
      columnStyles: Object.fromEntries(head.map((_, i) => [i, { halign: right.includes(i) ? 'right' : 'left' }])),
      didParseCell: ({ section, column, cell }) => {
        if (section === 'head') cell.styles.halign = right.includes(column.index) ? 'right' : 'left';
      },
    });

  doc.setFont('helvetica', 'bold').setFontSize(18).setTextColor(20).text('VITAL transformer report', margin, y + 10);
  y += 30;
  doc
    .setFont('helvetica', 'normal')
    .setFontSize(9)
    .setTextColor(110)
    .text(`${meta.rangeLabel} · ${meta.sourceLabel} · Generated ${formatDateTime(meta.generatedAt.toISOString())}`, margin, y);
  y += 8;

  section('Summary');
  autoTable(doc, {
    startY: y,
    body: [
      ['Energy used', `${energy.totalKwh.toFixed(3)} kWh`],
      ['Estimated cost', `${php(energy.totalCost)} at ${php(energy.ratePerKwh)} per kWh`],
      ['Peak load', energy.peakVa === null ? 'No data' : `${energy.peakVa.toFixed(0)} VA${energy.peakAt ? `, ${formatShortDateTime(energy.peakAt)}` : ''}`],
      ['Time over the limit', formatMinutes(energy.overloadMinutes)],
      [
        'Voltage',
        pq.minVoltageV === null || pq.avgVoltageV === null || pq.maxVoltageV === null
          ? 'No data'
          : `${pq.minVoltageV.toFixed(1)} V lowest, ${pq.avgVoltageV.toFixed(1)} V average, ${pq.maxVoltageV.toFixed(1)} V highest (nominal ${pq.nominalVoltageV} V)`,
      ],
      ['Sags and swells', `${formatMinutes(pq.sagMinutes)} below 90%, ${formatMinutes(pq.swellMinutes)} above 110%`],
      ['Average power factor', pq.avgPowerFactor === null ? 'No data' : `${pq.avgPowerFactor.toFixed(2)}, low for ${formatMinutes(pq.lowPowerFactorMinutes)}`],
      [
        'Power factor correction',
        pq.correction
          ? `About ${pq.correction.kvar.toFixed(3)} kvar (${pq.correction.capacitorUf.toFixed(1)} µF) to reach ${pq.correction.targetPowerFactor.toFixed(2)}`
          : 'Not needed',
      ],
      [
        'Transformer aging',
        `Average rate ${formatFactor(aging.avgAgingFactor)}, ${formatAgingHours(aging.equivalentHours)} of aging, ${Number(aging.lifeUsedPercent.toPrecision(2))}% of normal life (${aging.method} estimate)`,
      ],
      ['Alerts', `${alerts.total} (${alerts.overload} overload, ${alerts.temperature} temperature), ${alerts.unacknowledged} not acknowledged`],
      ['Typical response', alerts.medianResponseSeconds === null ? 'No acknowledged alerts' : formatSeconds(alerts.medianResponseSeconds)],
    ],
    margin: { left: margin, right: margin },
    styles: { font: 'helvetica', fontSize: 9, cellPadding: 4, textColor: 40 },
    columnStyles: { 0: { fontStyle: 'bold', cellWidth: 150 } },
    theme: 'plain',
  });

  section('Energy by day');
  table(
    ['Day', 'kWh', 'Cost', 'Average VA', 'Peak VA', 'Over the limit'],
    energy.days.filter((d) => d.samples > 0).map((d) => [
      dateLabel(d.date),
      d.kwh.toFixed(3),
      php(d.cost),
      d.avgVa?.toFixed(0) ?? '-',
      d.peakVa?.toFixed(0) ?? '-',
      d.overloadMinutes ? formatMinutes(d.overloadMinutes) : '-',
    ]),
    [1, 2, 3, 4, 5]
  );

  if (alerts.byPerson.length > 0) {
    section('Response times');
    table(
      ['Person', 'Alerts', 'Typical response'],
      alerts.byPerson.map((p) => [p.name, p.count, p.medianResponseSeconds === null ? '-' : formatSeconds(p.medianResponseSeconds)]),
      [1, 2]
    );
  }

  if (alerts.rows.length > 0) {
    section('Alerts');
    table(
      ['Time', 'Kind', 'Value', 'Limit', 'Response', 'Acknowledged by'],
      alerts.rows.map((a) => {
        const unit = a.kind === 'overload' ? 'VA' : '°C';
        return [
          formatShortDateTime(a.createdAt),
          a.kind === 'overload' ? 'Overload' : 'Temperature',
          `${a.value.toFixed(1)} ${unit}`,
          `${a.threshold} ${unit}`,
          a.responseMs === null ? 'Not yet' : formatSeconds(a.responseMs / 1000),
          a.acknowledgedByName ?? '-',
        ];
      }),
      [2, 3, 4]
    );
  }

  const pages = doc.getNumberOfPages();
  for (let page = 1; page <= pages; page++) {
    doc.setPage(page);
    doc.setFont('helvetica', 'normal').setFontSize(8).setTextColor(140);
    doc.text(`Page ${page} of ${pages}`, doc.internal.pageSize.getWidth() - margin, doc.internal.pageSize.getHeight() - 20, {
      align: 'right',
    });
  }

  return doc.output('arraybuffer');
}
