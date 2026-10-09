import { ArrowsClockwiseIcon, ChartLineIcon, FunnelSimpleIcon, MagnifyingGlassIcon, XIcon } from '@phosphor-icons/react';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Navigate } from 'react-router';

import { LogListSkeleton } from '@/components/ac/log-skeleton';
import { FilterSheet } from '@/components/logs/filter-sheet';
import { Button } from '@/components/ui/button';
import { Callout } from '@/components/ui/callout';
import { Card } from '@/components/ui/card';
import { EmptyState } from '@/components/ui/empty-state';
import { PageHeader } from '@/components/ui/page-header';
import { Pager } from '@/components/ui/pager';
import { SearchField } from '@/components/ui/search-field';
import { Segmented } from '@/components/ui/segmented';
import { Switch } from '@/components/ui/switch';
import { useAuth } from '@/features/auth/context';
import { useNotifications } from '@/features/notifications/context';
import * as readingsApi from '@/features/readings/api';
import { NO_FILTERS, activeChips, toQuery, withoutChip, type LogFilters } from '@/features/readings/log-filters';
import * as settingsApi from '@/features/settings/api';
import type { Settings } from '@/features/settings/types';
import type { Reading, TrendPoint } from '@/features/readings/types';
import { useDebounced } from '@/hooks/use-debounced';
import { useAppearance, useColorScheme } from '@/lib/appearance';
import { formatValue } from '@/lib/reading-format';
import { formatDayLabel, formatShortDateTime } from '@/lib/datetime';
import { PAGE_SIZE } from '@/lib/pagination';
import { cn } from '@/lib/utils';

const CHART_HEIGHT = 150;
const MAX_BAR_WIDTH = 44;
const BAR_GAP = 10;
/** Room under the baseline for day labels. */
const AXIS_HEIGHT = 16;
/** Room above the tallest bar for its value label. */
const LABEL_HEIGHT = 14;

type SourceFilter = 'hardware' | 'simulator' | null;

const SOURCE_FILTERS: { label: string; value: SourceFilter }[] = [
  { label: 'All', value: null },
  { label: 'Sensor', value: 'hardware' },
  { label: 'Simulated', value: 'simulator' },
];

/**
 * Caption under the chart. Days whose readings carried no power at all have a null
 * peak, so the summary reports the range and says so rather than printing NaN.
 */
function summarise(points: TrendPoint[]) {
  const peaks = points.map((p) => p.maxPowerVa).filter((peak) => peak !== null);
  const span = `Last ${points.length} ${points.length === 1 ? 'day' : 'days'}`;

  return peaks.length === 0 ? `${span} · no load recorded` : `${span} · peak ${Math.max(...peaks).toFixed(0)} VA`;
}

/**
 * Bars rather than a line: the series is usually a handful of days, and a single
 * day has no segment to draw at all.
 */
function TrendChart({
  points,
  color,
  gridColor,
  overColor,
  threshold,
  labelColor,
}: {
  points: TrendPoint[];
  color: string;
  gridColor: string;
  overColor: string;
  threshold: number | null;
  labelColor: string;
}) {
  const [width, setWidth] = useState(0);
  const box = useRef<HTMLDivElement>(null);

  // The bars are laid out in pixels, so they are redone whenever the card changes size.
  useEffect(() => {
    const node = box.current;
    if (!node) return;

    const observer = new ResizeObserver(([entry]) => setWidth(entry.contentRect.width));
    observer.observe(node);
    return () => observer.disconnect();
  }, []);

  const bars = useMemo(() => {
    if (width <= 0 || points.length === 0) return [];

    // Headroom above the peak so the tallest bar does not touch the value label. A day
    // with no power readings contributes nothing to the ceiling rather than dragging
    // it to zero.
    const ceiling = Math.max(...points.map((p) => p.maxPowerVa ?? 0), 1) * 1.2;
    const count = points.length;
    const barWidth = Math.min(MAX_BAR_WIDTH, (width - BAR_GAP * (count - 1)) / count);
    const spread = barWidth * count + BAR_GAP * (count - 1);
    const startX = (width - spread) / 2;
    const plot = CHART_HEIGHT - AXIS_HEIGHT - LABEL_HEIGHT;

    return points.map((point, index) => {
      const { avgPowerVa, maxPowerVa } = point;
      const height = avgPowerVa === null ? 0 : Math.max((avgPowerVa / ceiling) * plot, 2);

      return {
        point,
        avgPowerVa,
        maxPowerVa,
        x: startX + index * (barWidth + BAR_GAP),
        y: CHART_HEIGHT - AXIS_HEIGHT - height,
        width: barWidth,
        height,
        peakY:
          maxPowerVa === null ? null : CHART_HEIGHT - AXIS_HEIGHT - (maxPowerVa / ceiling) * plot,
      };
    });
  }, [points, width]);

  const baseline = CHART_HEIGHT - AXIS_HEIGHT;

  return (
    <div ref={box} style={{ height: CHART_HEIGHT }} className="w-full">
      {width > 0 ? (
        <svg width={width} height={CHART_HEIGHT} role="img" aria-label="Daily average load, last 7 days">
          {bars.map((bar) => {
            const over =
              threshold !== null && bar.maxPowerVa !== null && bar.maxPowerVa >= threshold;
            const fill = over ? overColor : color;

            return (
              <g key={bar.point.day}>
                {/* A day whose readings carried no power at all draws no bar and no
                    peak, so an unmeasured day is not mistaken for an idle one. */}
                <text
                  x={bar.x + bar.width / 2}
                  y={bar.y - 5}
                  fill={labelColor}
                  fontSize={9}
                  fontWeight="600"
                  textAnchor="middle">
                  {bar.avgPowerVa === null ? 'No data' : bar.avgPowerVa.toFixed(0)}
                </text>
                {bar.height > 0 ? (
                  <rect
                    x={bar.x}
                    y={bar.y}
                    width={bar.width}
                    height={bar.height}
                    rx={4}
                    fill={fill}
                  />
                ) : null}
                {/* Peak sits above the average bar, so a spiky day is not hidden by its mean. */}
                {bar.peakY === null ? null : (
                  <line
                    x1={bar.x}
                    y1={bar.peakY}
                    x2={bar.x + bar.width}
                    y2={bar.peakY}
                    stroke={fill}
                    strokeWidth={1.5}
                    strokeDasharray="3 2"
                  />
                )}
                <text
                  x={bar.x + bar.width / 2}
                  y={CHART_HEIGHT - 4}
                  fill={labelColor}
                  fontSize={9}
                  textAnchor="middle">
                  {formatDayLabel(bar.point.day)}
                </text>
              </g>
            );
          })}
          <line x1={0} y1={baseline} x2={width} y2={baseline} stroke={gridColor} strokeWidth={1} />
        </svg>
      ) : null}
    </div>
  );
}

const OVER_TINT = 'linear-gradient(hsl(var(--destructive) / 0.05), hsl(var(--destructive) / 0.05))';

const SOURCE_LABEL: Record<string, string> = { hardware: 'Sensor', simulator: 'Simulated' };

/** A limit that was not kept for older records. Quieter than "No data", which means a sensor. */
const NOT_RECORDED = '—';

/** Every field a record carries, as table columns after Time. */
const COLUMNS: { label: string; align: 'left' | 'right'; value: (row: Reading) => string; hint?: string }[] = [
  { label: 'VA', align: 'right', value: (row) => formatValue(row.apparentPowerVa, 0) },
  // The alarm the row was judged against, so an old overload still reads correctly after
  // the limit is moved. Records from before it was kept show a dash, not a guess.
  {
    label: 'Alarm',
    align: 'right',
    value: (row) => (row.loadThresholdVa == null ? NOT_RECORDED : row.loadThresholdVa.toFixed(0)),
    hint: 'Alarm level in VA when this was recorded',
  },
  { label: 'Status', align: 'left', value: (row) => (row.status === 'overload' ? 'Overload' : 'Normal') },
  { label: 'V', align: 'right', value: (row) => formatValue(row.voltageV, 1) },
  { label: 'A', align: 'right', value: (row) => formatValue(row.currentA, 2) },
  { label: 'W', align: 'right', value: (row) => formatValue(row.powerW, 0) },
  { label: 'PF', align: 'right', value: (row) => formatValue(row.powerFactor, 2) },
  { label: 'Hz', align: 'right', value: (row) => formatValue(row.frequencyHz, 2) },
  { label: 'kWh', align: 'right', value: (row) => formatValue(row.energyKwh, 3) },
  { label: '°C', align: 'right', value: (row) => formatValue(row.temperatureC, 1) },
  { label: 'Source', align: 'left', value: (row) => SOURCE_LABEL[row.source] ?? row.source },
];

export default function LogsScreen() {
  const { token, user } = useAuth();
  const { markLogsSeen } = useNotifications();
  const { primary } = useAppearance();
  const { colorScheme } = useColorScheme();
  const isDark = colorScheme === 'dark';
  const ac = primary.hex;
  const muted = isDark ? '#a1a1aa' : '#71717a';
  const danger = isDark ? '#f87171' : '#dc2626';
  const gridColor = 'rgba(148, 163, 184, 0.25)';

  const [rows, setRows] = useState<Reading[]>([]);
  const [total, setTotal] = useState(0);
  const [offset, setOffset] = useState(0);
  const [points, setPoints] = useState<TrendPoint[]>([]);
  const [query, setQuery] = useState('');
  const [onlyOverload, setOnlyOverload] = useState(false);
  const [source, setSource] = useState<SourceFilter>(null);
  const [filters, setFilters] = useState<LogFilters>(NO_FILTERS);
  const [showFilters, setShowFilters] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  /** False until the first page lands. After that the pager and count stay while a page loads. */
  const [loaded, setLoaded] = useState(false);
  const [settings, setSettings] = useState<Settings | null>(null);
  const threshold = settings?.loadThresholdVa ?? null;

  const debouncedQuery = useDebounced(query);

  // The bars are judged against the alarm, and a log full of OVERLOAD says nothing
  // without the number it was judged by, which is adjustable in Settings.
  useEffect(() => {
    if (!token) return;

    settingsApi
      .read(token)
      .then(setSettings)
      .catch(() => undefined);
  }, [token]);

  // A narrowed result set can be shorter than the current offset, which would land the
  // pager on an empty page, so any filter change returns to page one.
  useEffect(() => {
    setOffset(0);
  }, [debouncedQuery, onlyOverload, source, filters]);

  // The records only. Paging and filtering change this list and nothing else on the page.
  const loadRecords = useCallback(async () => {
    setLoading(true);
    try {
      const history = await readingsApi.history(token ?? '', {
        limit: PAGE_SIZE,
        offset,
        status: onlyOverload ? 'overload' : undefined,
        source: source ?? undefined,
        q: debouncedQuery,
        ...toQuery(filters),
      });
      setRows(history.rows);
      setTotal(history.total);
      setError(null);
    } catch (caught) {
      setError((caught as Error).message);
    } finally {
      setLoading(false);
      setLoaded(true);
    }
  }, [token, onlyOverload, source, debouncedQuery, offset, filters]);

  // The chart covers the last seven days whatever page or filter is showing, so it is
  // fetched on its own and not again on every page turn.
  const loadTrend = useCallback(async () => {
    try {
      setPoints(await readingsApi.trend(token ?? '', 7));
    } catch {
      // The records carry their own error; an empty chart says enough here.
    }
  }, [token]);

  useEffect(() => {
    void loadRecords();
  }, [loadRecords]);

  useEffect(() => {
    void loadTrend();
  }, [loadTrend]);

  function refresh() {
    void loadRecords();
    void loadTrend();
  }

  // Clears the tab dot once this page's data has loaded.
  useEffect(() => {
    if (!loading) markLogsSeen();
  }, [loading, markLogsSeen]);

  // Paging replaces every row, so staying scrolled down would land mid-way through
  // records you have not seen.
  function goToPage(next: number) {
    setOffset(next);
    window.scrollTo({ top: 0, behavior: 'smooth' });
  }

  const chips = activeChips(filters);
  const filtering = debouncedQuery.trim().length > 0 || onlyOverload || source !== null || chips.length > 0;

  // Hiding the tab only removes the link; `/logs` typed into the address bar still lands
  // here. The API enforces this too; the redirect just avoids a wall of 403s.
  if (!token) return <Navigate to="/login" replace />;
  if (user && user.role !== 'admin') return <Navigate to="/dashboard" replace />;

  return (
    <>
      <PageHeader
        icon={ChartLineIcon}
        iconColor={ac}
        title="Logs"
        actions={
          <Button
            variant="ghost"
            size="icon"
            className="size-8 rounded-full"
            aria-label="Refresh"
            disabled={loading}
            onClick={refresh}>
            <ArrowsClockwiseIcon weight="bold" className={cn(loading && 'animate-spin')} aria-hidden="true" />
          </Button>
        }
      />

      <Card className="gap-3 p-4">
        <div className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1">
          <div>
            <h2 className="text-sm font-semibold">Daily average load</h2>
            <p className="text-muted-foreground text-xs">
              {points.length === 0 ? 'No samples yet' : summarise(points)}
            </p>
          </div>
          {/* The limits the bars and rows are judged by, kept beside the chart they explain. */}
          {settings ? (
            <p className="text-muted-foreground text-[11px] tabular-nums">
              Alarm {settings.loadThresholdVa} VA · Trip {settings.tripThresholdVa} VA ·{' '}
              {settings.tempThresholdC} °C
            </p>
          ) : null}
        </div>
        <TrendChart
          points={points}
          color={ac}
          gridColor={gridColor}
          overColor={danger}
          threshold={threshold}
          labelColor={muted}
        />
      </Card>

      <SearchField value={query} onValueChange={setQuery} placeholder="Search status, source, VA, date" />

      <div className="flex flex-wrap items-center justify-between gap-3">
        <Segmented
          aria-label="Source"
          options={SOURCE_FILTERS}
          value={source}
          onValueChange={setSource}
          size="sm"
        />
        {/* Full width once the row wraps on a phone, with the toggle and the button at
            opposite ends; beside the source switch on a wider screen. */}
        <div className="flex w-full items-center justify-between gap-3 sm:w-auto sm:justify-end">
          <label className="flex cursor-pointer items-center gap-2 text-sm font-medium">
            Overloads only
            <Switch aria-label="Overloads only" checked={onlyOverload} onCheckedChange={setOnlyOverload} />
          </label>
          <Button variant="outline" size="sm" onClick={() => setShowFilters(true)}>
            <FunnelSimpleIcon weight="bold" aria-hidden="true" />
            Filters
            {chips.length > 0 ? (
              <span className="bg-primary text-primary-foreground grid size-5 place-items-center rounded-full text-[11px] font-semibold">
                {chips.length}
              </span>
            ) : null}
          </Button>
        </div>
      </div>

      {chips.length > 0 ? (
        <ul className="flex flex-wrap gap-2" aria-label="Active filters">
          {chips.map((chip) => (
            <li key={chip.key}>
              <button
                type="button"
                onClick={() => setFilters((current) => withoutChip(current, chip.key))}
                aria-label={`Remove filter: ${chip.label}`}
                className="bg-accent hover:bg-accent/70 flex h-7 cursor-pointer items-center gap-1.5 rounded-md px-2.5 text-xs font-medium transition-colors">
                {chip.label}
                <XIcon size={12} weight="bold" aria-hidden="true" />
              </button>
            </li>
          ))}
          <li>
            <button
              type="button"
              onClick={() => setFilters(NO_FILTERS)}
              className="text-muted-foreground hover:text-foreground h-7 cursor-pointer px-1 text-xs font-medium">
              Clear all
            </button>
          </li>
        </ul>
      ) : null}

      {loaded ? (
        <p className="text-muted-foreground -mb-2 px-1 text-xs tabular-nums">
          {total} {total === 1 ? 'record' : 'records'}
          {filtering ? ' matching filters' : ''}
        </p>
      ) : null}

      {error ? <Callout tone="destructive" title="Could not load the logs" description={error} /> : null}

      {loading ? <LogListSkeleton /> : null}

      {loaded && !loading && rows.length === 0 ? (
        <EmptyState
          icon={filtering ? MagnifyingGlassIcon : ChartLineIcon}
          title={filtering ? 'No matching records' : 'No records yet'}
          description={filtering ? 'Try a different search or filter.' : 'Readings appear here once sampled.'}
        />
      ) : null}

      {!loading && rows.length > 0 ? (
        <Card className="gap-0 overflow-hidden py-0">
          {/* Scrolls sideways on a phone; Time stays pinned so a row is never anonymous. */}
          <div className="overflow-x-auto">
            <table className="w-full min-w-[780px] text-xs tabular-nums">
              <thead className="text-muted-foreground text-[11px]">
                <tr className="bg-muted border-b">
                  <th scope="col" className="bg-muted sticky left-0 z-10 px-4 py-2.5 text-left font-medium">
                    Time
                  </th>
                  {COLUMNS.map((column) => (
                    <th
                      key={column.label}
                      scope="col"
                      title={column.hint}
                      className={cn('px-3 py-2.5 font-medium', column.align === 'left' ? 'text-left' : 'text-right')}>
                      {column.label}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody className="divide-y">
                {rows.map((row) => {
                  const over = row.status === 'overload';
                  return (
                    <tr key={row.id} className={cn('group', over && 'bg-destructive/5')}>
                      {/* Opaque, or the columns scrolling under it would show through. */}
                      <th
                        scope="row"
                        className="bg-card sticky left-0 z-10 whitespace-nowrap px-4 py-2.5 text-left font-medium"
                        // The row's tint, painted over the opaque fill so it reaches this cell too.
                        style={over ? { backgroundImage: OVER_TINT } : undefined}>
                        <time dateTime={row.recordedAt}>{formatShortDateTime(row.recordedAt)}</time>
                      </th>
                      {COLUMNS.map((column) => {
                        const emphasis = column.label === 'VA' || (over && column.label === 'Status');
                        return (
                          <td
                            key={column.label}
                            className={cn(
                              'whitespace-nowrap px-3 py-2.5',
                              column.align === 'left' ? 'text-left' : 'text-right',
                              emphasis && 'font-semibold',
                              !emphasis && 'text-muted-foreground'
                            )}
                            style={
                              over && emphasis
                                ? { color: danger }
                                : column.label === 'VA'
                                  ? { color: ac }
                                  : undefined
                            }>
                            {column.value(row)}
                          </td>
                        );
                      })}
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </Card>
      ) : null}

      {!loaded ? null : (
        <Pager
          total={total}
          limit={PAGE_SIZE}
          offset={offset}
          onOffsetChange={goToPage}
          noun="record"
          // Lifts the jump field above the on-screen keyboard once it has opened.
          onInputFocus={() =>
            setTimeout(() => window.scrollTo({ top: document.documentElement.scrollHeight, behavior: 'smooth' }), 150)
          }
        />
      )}
      <FilterSheet visible={showFilters} value={filters} onApply={setFilters} onClose={() => setShowFilters(false)} />
    </>
  );
}
