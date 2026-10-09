import type { HistoryFilters } from '@/features/readings/api';

export type DateRange = 'all' | 'today' | '7d' | '30d' | 'custom';
export type LogSort = NonNullable<HistoryFilters['sort']>;

/** What the Filters sheet edits. Numbers stay as typed text until they are sent. */
export type LogFilters = {
  range: DateRange;
  /** `YYYY-MM-DD`, the value of a date input. Only used for a custom range. */
  fromDate: string;
  toDate: string;
  minVa: string;
  maxVa: string;
  minTempC: string;
  sort: LogSort;
};

export const NO_FILTERS: LogFilters = {
  range: 'all',
  fromDate: '',
  toDate: '',
  minVa: '',
  maxVa: '',
  minTempC: '',
  sort: 'newest',
};

export const RANGE_LABEL: Record<DateRange, string> = {
  all: 'All time',
  today: 'Today',
  '7d': 'Last 7 days',
  '30d': 'Last 30 days',
  custom: 'Custom',
};

export const SORT_LABEL: Record<LogSort, string> = {
  newest: 'Newest first',
  oldest: 'Oldest first',
  load: 'Highest load',
  temperature: 'Highest temperature',
};

function number(text: string): number | undefined {
  const value = Number(text);
  return text.trim() === '' || !Number.isFinite(value) ? undefined : value;
}

/** Midnight at the start of a local calendar day. */
function startOfDay(date: Date) {
  return new Date(date.getFullYear(), date.getMonth(), date.getDate());
}

/** A `YYYY-MM-DD` date input value as local midnight. */
function fromDateInput(value: string): Date | null {
  const [y, m, d] = value.split('-').map(Number);
  return y && m && d ? new Date(y, m - 1, d) : null;
}

/**
 * The query the API takes. Days are the viewer's local days, sent as instants, so
 * "Today" means today where the person is looking, not today in UTC.
 */
export function toQuery(filters: LogFilters, now: Date = new Date()): Partial<HistoryFilters> {
  const query: Partial<HistoryFilters> = {
    minVa: number(filters.minVa),
    maxVa: number(filters.maxVa),
    minTempC: number(filters.minTempC),
    sort: filters.sort,
  };

  const today = startOfDay(now);
  const daysBack = (days: number) => new Date(today.getFullYear(), today.getMonth(), today.getDate() - days);

  switch (filters.range) {
    case 'today':
      query.from = today.toISOString();
      break;
    case '7d':
      query.from = daysBack(6).toISOString();
      break;
    case '30d':
      query.from = daysBack(29).toISOString();
      break;
    case 'custom': {
      const from = fromDateInput(filters.fromDate);
      const to = fromDateInput(filters.toDate);
      if (from) query.from = from.toISOString();
      // The end date is inclusive on screen, so the bound is the following midnight.
      if (to) query.to = new Date(to.getFullYear(), to.getMonth(), to.getDate() + 1).toISOString();
      break;
    }
    case 'all':
      break;
  }

  return query;
}

/** One removable chip per filter that is set, in the order they appear in the sheet. */
export function activeChips(filters: LogFilters): { key: keyof LogFilters | 'load'; label: string }[] {
  const chips: { key: keyof LogFilters | 'load'; label: string }[] = [];

  if (filters.range === 'custom' && (filters.fromDate || filters.toDate)) {
    chips.push({ key: 'range', label: `${filters.fromDate || '…'} to ${filters.toDate || '…'}` });
  } else if (filters.range !== 'all' && filters.range !== 'custom') {
    chips.push({ key: 'range', label: RANGE_LABEL[filters.range] });
  }

  const min = number(filters.minVa);
  const max = number(filters.maxVa);
  if (min !== undefined && max !== undefined) chips.push({ key: 'load', label: `${min}–${max} VA` });
  else if (min !== undefined) chips.push({ key: 'load', label: `At least ${min} VA` });
  else if (max !== undefined) chips.push({ key: 'load', label: `Up to ${max} VA` });

  const temp = number(filters.minTempC);
  if (temp !== undefined) chips.push({ key: 'minTempC', label: `At least ${temp} °C` });

  if (filters.sort !== 'newest') chips.push({ key: 'sort', label: SORT_LABEL[filters.sort] });

  return chips;
}

/** Clears the filter a chip stands for. */
export function withoutChip(filters: LogFilters, key: keyof LogFilters | 'load'): LogFilters {
  switch (key) {
    case 'range':
      return { ...filters, range: 'all', fromDate: '', toDate: '' };
    case 'load':
      return { ...filters, minVa: '', maxVa: '' };
    case 'sort':
      return { ...filters, sort: 'newest' };
    default:
      return { ...filters, [key]: '' };
  }
}
