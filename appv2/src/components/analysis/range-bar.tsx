import { Input } from '@/components/ui/input';
import { Segmented } from '@/components/ui/segmented';
import { RANGE_LABEL, type AnalysisRange, type RangeChoice } from '@/features/insights/range';
import type { InsightSource } from '@/features/insights/types';

const RANGES: { label: string; value: RangeChoice }[] = [
  { label: '7 days', value: '7d' },
  { label: '30 days', value: '30d' },
  { label: 'Past year', value: 'year' },
  { label: 'Custom', value: 'custom' },
];

const SOURCES: { label: string; value: InsightSource }[] = [
  { label: 'Sensor', value: 'hardware' },
  { label: 'Simulated', value: 'simulator' },
  { label: 'All', value: null },
];

export function RangeBar({ value, onChange }: { value: AnalysisRange; onChange: (next: AnalysisRange) => void }) {
  const set = (patch: Partial<AnalysisRange>) => onChange({ ...value, ...patch });
  const invalid = value.range === 'custom' && value.fromDate && value.toDate && value.fromDate > value.toDate;

  return (
    <div className="space-y-2">
      <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
        <Segmented
          aria-label="Date range"
          options={RANGES}
          value={value.range}
          onValueChange={(range) => set({ range })}
          size="sm"
          fill
          className="sm:w-auto"
        />
        <Segmented
          aria-label="Source"
          options={SOURCES}
          value={value.source}
          onValueChange={(source) => set({ source })}
          size="sm"
          fill
          className="sm:w-auto"
        />
      </div>
      {value.range === 'custom' ? (
        <div className="grid grid-cols-1 gap-2 min-[360px]:grid-cols-2">
          <label className="space-y-1">
            <span className="text-muted-foreground block text-xs">From</span>
            <Input type="date" value={value.fromDate} onChange={(event) => set({ fromDate: event.target.value })} />
          </label>
          <label className="space-y-1">
            <span className="text-muted-foreground block text-xs">To</span>
            <Input type="date" value={value.toDate} onChange={(event) => set({ toDate: event.target.value })} />
          </label>
        </div>
      ) : null}
      {invalid ? <p className="text-destructive text-xs">The start date is after the end date.</p> : null}
      <span className="sr-only">{RANGE_LABEL[value.range]}</span>
    </div>
  );
}
