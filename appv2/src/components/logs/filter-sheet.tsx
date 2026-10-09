import { CheckIcon, LightningIcon, ThermometerIcon } from '@phosphor-icons/react';
import { useEffect, useState, type ReactNode } from 'react';

import { BottomSheet } from '@/components/bottom-sheet';
import { Button } from '@/components/ui/button';
import { IconInput } from '@/components/ui/icon-input';
import { Input } from '@/components/ui/input';
import {
  NO_FILTERS,
  RANGE_LABEL,
  SORT_LABEL,
  type DateRange,
  type LogFilters,
  type LogSort,
} from '@/features/readings/log-filters';
import { useAppearance } from '@/lib/appearance';

const RANGES = (Object.keys(RANGE_LABEL) as DateRange[]).map((value) => ({ value, label: RANGE_LABEL[value] }));
const SORTS = (Object.keys(SORT_LABEL) as LogSort[]).map((value) => ({ value, label: SORT_LABEL[value] }));

function Group({ title, children }: { title: string; children: ReactNode }) {
  return (
    <fieldset className="space-y-2">
      <legend className="text-sm font-medium">{title}</legend>
      {children}
    </fieldset>
  );
}

/** A row of choice chips that wraps, for lists too long for one segmented control. */
function Chips<T extends string>({
  options,
  value,
  onChange,
  label,
}: {
  options: { value: T; label: string }[];
  value: T;
  onChange: (value: T) => void;
  label: string;
}) {
  return (
    <div role="radiogroup" aria-label={label} className="flex flex-wrap gap-2">
      {options.map((option) => {
        const selected = option.value === value;
        return (
          <button
            key={option.value}
            type="button"
            role="radio"
            aria-checked={selected}
            onClick={() => onChange(option.value)}
            className={
              selected
                ? 'bg-primary text-primary-foreground h-8 cursor-pointer rounded-md px-3 text-xs font-medium'
                : 'bg-muted text-muted-foreground hover:text-foreground h-8 cursor-pointer rounded-md px-3 text-xs font-medium transition-colors'
            }>
            {option.label}
          </button>
        );
      })}
    </div>
  );
}

/**
 * Date, load, temperature and sort for the records table. Edited as a draft and applied
 * together, so the table does not reload on every keystroke in a number field.
 */
export function FilterSheet({
  visible,
  value,
  onApply,
  onClose,
}: {
  visible: boolean;
  value: LogFilters;
  onApply: (next: LogFilters) => void;
  onClose: () => void;
}) {
  const { primary } = useAppearance();
  const [draft, setDraft] = useState(value);

  useEffect(() => {
    if (visible) setDraft(value);
  }, [visible, value]);

  const set = <K extends keyof LogFilters>(key: K, next: LogFilters[K]) =>
    setDraft((current) => ({ ...current, [key]: next }));

  const min = draft.minVa.trim() === '' ? null : Number(draft.minVa);
  const max = draft.maxVa.trim() === '' ? null : Number(draft.maxVa);
  const loadError = min !== null && max !== null && min > max ? 'The minimum is above the maximum.' : null;
  const dateError =
    draft.range === 'custom' && draft.fromDate && draft.toDate && draft.fromDate > draft.toDate
      ? 'The start date is after the end date.'
      : null;

  return (
    <BottomSheet visible={visible} title="Filters" onClose={onClose}>
      <form
        className="flex flex-col gap-5"
        onSubmit={(event) => {
          event.preventDefault();
          if (loadError || dateError) return;
          onApply(draft);
          onClose();
        }}>
        <Group title="Date">
          <Chips label="Date range" options={RANGES} value={draft.range} onChange={(range) => set('range', range)} />
          {draft.range === 'custom' ? (
            <div className="grid grid-cols-2 gap-2">
              <label className="space-y-1">
                <span className="text-muted-foreground block text-xs">From</span>
                <Input type="date" value={draft.fromDate} onChange={(event) => set('fromDate', event.target.value)} />
              </label>
              <label className="space-y-1">
                <span className="text-muted-foreground block text-xs">To</span>
                <Input type="date" value={draft.toDate} onChange={(event) => set('toDate', event.target.value)} />
              </label>
            </div>
          ) : null}
          {dateError ? <p className="text-destructive text-xs">{dateError}</p> : null}
        </Group>

        <Group title="Load">
          <div className="grid grid-cols-2 gap-2">
            <IconInput
              icon={LightningIcon}
              iconColor={primary.hex}
              unit="VA"
              inputMode="decimal"
              aria-label="Minimum load in VA"
              placeholder="Min"
              value={draft.minVa}
              onChange={(event) => set('minVa', event.target.value)}
            />
            <IconInput
              icon={LightningIcon}
              iconColor={primary.hex}
              unit="VA"
              inputMode="decimal"
              aria-label="Maximum load in VA"
              placeholder="Max"
              value={draft.maxVa}
              onChange={(event) => set('maxVa', event.target.value)}
            />
          </div>
          {loadError ? <p className="text-destructive text-xs">{loadError}</p> : null}
        </Group>

        <Group title="Temperature">
          <IconInput
            icon={ThermometerIcon}
            iconColor={primary.hex}
            unit="°C"
            inputMode="decimal"
            aria-label="Minimum temperature in °C"
            placeholder="At or above"
            value={draft.minTempC}
            onChange={(event) => set('minTempC', event.target.value)}
          />
        </Group>

        <Group title="Sort">
          <Chips label="Sort" options={SORTS} value={draft.sort} onChange={(sort) => set('sort', sort)} />
        </Group>

        <div className="flex gap-2">
          <Button variant="outline" className="flex-1" onClick={() => setDraft(NO_FILTERS)}>
            Clear all
          </Button>
          <Button type="submit" className="flex-1" disabled={Boolean(loadError || dateError)}>
            <CheckIcon weight="bold" aria-hidden="true" />
            Apply
          </Button>
        </div>
      </form>
    </BottomSheet>
  );
}
