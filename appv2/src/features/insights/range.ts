import { useEffect, useState } from 'react';

import type { InsightQuery } from '@/features/insights/api';
import type { InsightSource } from '@/features/insights/types';

export type RangeChoice = '7d' | '30d' | 'year' | 'custom';

export type AnalysisRange = {
  range: RangeChoice;
  /** `YYYY-MM-DD`, for a custom range. */
  fromDate: string;
  toDate: string;
  source: InsightSource;
};

const KEY = 'vital.analysis-range';
const DEFAULT: AnalysisRange = { range: '30d', fromDate: '', toDate: '', source: 'hardware' };
const CHOICES: RangeChoice[] = ['7d', '30d', 'year', 'custom'];

function load(): AnalysisRange {
  try {
    const saved = { ...DEFAULT, ...(JSON.parse(sessionStorage.getItem(KEY) ?? '{}') as Partial<AnalysisRange>) };
    return CHOICES.includes(saved.range) ? saved : DEFAULT;
  } catch {
    return DEFAULT;
  }
}

/** Shared by every analysis page, so moving between them keeps the same range. */
export function useAnalysisRange() {
  const [value, setValue] = useState(load);

  useEffect(() => {
    try {
      sessionStorage.setItem(KEY, JSON.stringify(value));
    } catch {
      // storage blocked: the range just resets per page
    }
  }, [value]);

  return [value, setValue] as const;
}

/** A local date as YYYY-MM-DD. */
export function isoDate(date: Date): string {
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

export function toInsightQuery({ range, fromDate, toDate, source }: AnalysisRange, now = new Date()): InsightQuery {
  const daysBack = (days: number) => isoDate(new Date(now.getFullYear(), now.getMonth(), now.getDate() - days));
  const today = isoDate(now);

  switch (range) {
    case '7d':
      return { from: daysBack(6), to: today, source };
    case '30d':
      return { from: daysBack(29), to: today, source };
    case 'year':
      return { from: daysBack(365), to: today, source };
    default:
      return { from: fromDate || undefined, to: toDate || undefined, source };
  }
}

export const RANGE_LABEL: Record<RangeChoice, string> = {
  '7d': 'Last 7 days',
  '30d': 'Last 30 days',
  year: 'Past year',
  custom: 'Custom range',
};

/** "Last 30 days", or "2026-09-01 to 2026-09-24" for a custom range. */
export function describeRange({ range, fromDate, toDate }: AnalysisRange): string {
  if (range !== 'custom') return RANGE_LABEL[range];
  if (fromDate && toDate) return `${fromDate} to ${toDate}`;
  if (fromDate) return `From ${fromDate}`;
  if (toDate) return `The week to ${toDate}`;
  return 'Last 7 days';
}
