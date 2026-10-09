import {
  BellIcon,
  CaretDownIcon,
  CheckCircleIcon,
  MagnifyingGlassIcon,
  ShieldCheckIcon,
  ThermometerIcon,
  WarningIcon,
  type Icon,
} from '@phosphor-icons/react';
import { useCallback, useEffect, useRef, useState } from 'react';

import { AlertListSkeleton } from '@/components/ac/alert-skeleton';
import { MetricGrid } from '@/components/ac/metric-grid';
import { Button } from '@/components/ui/button';
import { Callout } from '@/components/ui/callout';
import { Card } from '@/components/ui/card';
import { EmptyState } from '@/components/ui/empty-state';
import { PageHeader } from '@/components/ui/page-header';
import { Pager } from '@/components/ui/pager';
import { SearchField } from '@/components/ui/search-field';
import { Segmented } from '@/components/ui/segmented';
import { SettingsSection } from '@/components/ui/settings-list';
import { Skeleton } from '@/components/ui/skeleton';
import * as alertsApi from '@/features/alerts/api';
import type { Alert, AlertKind } from '@/features/alerts/types';
import { useAuth } from '@/features/auth/context';
import * as usersApi from '@/features/users/api';
import { useNotifications } from '@/features/notifications/context';
import { useDebounced } from '@/hooks/use-debounced';
import { usePoll } from '@/hooks/use-poll';
import { useAppearance } from '@/lib/appearance';
import { formatShortDateTime } from '@/lib/datetime';
import { PAGE_SIZE, type Page } from '@/lib/pagination';
import { cn } from '@/lib/utils';

const POLL_MS = 2000;

const KIND: Record<AlertKind, { title: string; unit: string; icon: Icon }> = {
  overload: { title: 'Overload', unit: 'VA', icon: WarningIcon },
  temperature: { title: 'High temperature', unit: '°C', icon: ThermometerIcon },
};

const KINDS: { label: string; value: AlertKind | null }[] = [
  { label: 'All', value: null },
  { label: 'Overload', value: 'overload' },
  { label: 'Temperature', value: 'temperature' },
];

/** Whether the list shows only open alerts or the whole history. */
const SCOPES = [
  { label: 'Active', value: false },
  { label: 'All', value: true },
];

/** 42.0s under a minute, then 14m 3s, then 2h 5m: seconds stop mattering past a minute. */
function formatDuration(ms: number): string {
  const seconds = ms / 1000;
  if (seconds < 60) return `${seconds.toFixed(1)}s`;
  const whole = Math.round(seconds);
  const hours = Math.floor(whole / 3600);
  const minutes = Math.floor((whole % 3600) / 60);
  return hours > 0 ? `${hours}h ${minutes}m` : `${minutes}m ${whole % 60}s`;
}

/**
 * "Responded in 42.0s by Maria Santos". The API sends only the acknowledger's account id,
 * so the name is whatever `nameOf` can resolve; an id it cannot resolve is left out rather
 * than shown, because a raw id means nothing to anyone reading the card.
 */
function responseLabel(alert: Alert, nameOf: (id: string) => string | null): string {
  const took = alert.responseMs === null ? null : formatDuration(alert.responseMs);
  const name = alert.acknowledgedBy ? nameOf(alert.acknowledgedBy) : null;
  const by = name ? ` by ${name}` : '';

  return took ? `Responded in ${took}${by}` : `Acknowledged${by}`;
}

/** Whether the trigger reading is still attached; it is pruned with old readings. */
function hasReading(alert: Alert) {
  return alert.readingId !== null && alert.voltageV !== undefined;
}

export default function AlertsScreen() {
  const { token, user } = useAuth();
  const { silence } = useNotifications();
  const isAdmin = user?.role === 'admin';
  /** Account id to display name. Only an admin may list accounts, so for a user it stays empty. */
  const [names, setNames] = useState<Map<string, string>>(new Map());

  useEffect(() => {
    if (!token || !isAdmin) return;

    usersApi
      .list(token)
      .then((accounts) => setNames(new Map(accounts.map((a) => [a.id, a.fullName || a.username]))))
      .catch(() => undefined);
  }, [token, isAdmin]);

  const nameOf = useCallback(
    (id: string) => (id === user?.id ? 'you' : (names.get(id) ?? null)),
    [names, user?.id]
  );
  const { primary } = useAppearance();

  const [showAll, setShowAll] = useState(false);
  const [query, setQuery] = useState('');
  const [kind, setKind] = useState<AlertKind | null>(null);
  const [offset, setOffset] = useState(0);
  const [busy, setBusy] = useState<number | null>(null);
  const [ackError, setAckError] = useState<string | null>(null);
  const [nonce, setNonce] = useState(0);
  const [expanded, setExpanded] = useState<Set<number>>(new Set());
  // While set, the list is held frozen so a just-acknowledged card shows its acknowledged
  // state for a beat before the refetch drops it.
  const [frozen, setFrozen] = useState<Alert[] | null>(null);

  const ackTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const debouncedQuery = useDebounced(query);

  // A narrowed result set can be shorter than the current offset, which would land the
  // pager on an empty page, so any filter change returns to page one.
  useEffect(() => {
    setOffset(0);
  }, [debouncedQuery, kind, showAll]);

  // Paging replaces every alert, so staying scrolled down would land mid-way through
  // ones you have not seen.
  function goToPage(next: number) {
    setOffset(next);
    window.scrollTo({ top: 0, behavior: 'smooth' });
  }

  function toggle(id: number) {
    setExpanded((current) => {
      const next = new Set(current);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  const fetcher = useCallback(
    (signal: AbortSignal) =>
      alertsApi.list(
        token ?? '',
        { activeOnly: !showAll, q: debouncedQuery, kind: kind ?? undefined, limit: PAGE_SIZE, offset },
        signal
      ),
    // `nonce` is how an acknowledge forces a reload.
    [token, showAll, debouncedQuery, kind, offset, nonce]
  );

  // A filter change resets: the rows on screen no longer answer the new question. A page
  // turn does not, so the count and pager stay while only the list shows it is loading.
  // An acknowledge only reloads, so one row changing does not blank the list.
  const { data, error } = usePoll<Page<Alert>>(fetcher, POLL_MS, Boolean(token), {
    resetKey: `${showAll}|${kind}|${debouncedQuery}`,
    reloadKey: nonce,
  });

  const rows = data?.rows ?? [];
  const list = frozen ?? rows;
  const total = data?.total ?? 0;

  async function acknowledge(id: number) {
    // Before the request, not after it: acknowledging is someone saying they have seen
    // it, and the alarm should stop when they say so, not when the server agrees.
    silence();

    setBusy(id);
    setAckError(null);
    try {
      const updated = await alertsApi.acknowledge(token ?? '', id);
      // Merged, not replaced: the response is the alert without its joined reading, so
      // overwriting would strip the measurements off the card while it is being read.
      setFrozen((current) => (current ?? rows).map((a) => (a.id === id ? { ...a, ...updated } : a)));

      if (ackTimer.current) clearTimeout(ackTimer.current);
      ackTimer.current = setTimeout(() => {
        setFrozen(null);
        setNonce((n) => n + 1);
      }, 2000);
    } catch (caught) {
      // Losing the race to another engineer acknowledging the same alert is the ordinary
      // way to get here, not an edge case.
      setAckError((caught as Error).message);
    } finally {
      setBusy(null);
    }
  }

  useEffect(
    () => () => {
      if (ackTimer.current) clearTimeout(ackTimer.current);
    },
    []
  );

  const filtering = debouncedQuery.trim().length > 0 || kind !== null;
  // Null data means the first poll has not landed; an empty page is a real empty result.
  const loading = data === null && error === null;
  // The page on screen is the previous one until the requested page arrives.
  const turningPage = data !== null && data.offset !== offset;
  const open = list.filter((alert) => alert.acknowledgedAt === null);
  const handled = list.filter((alert) => alert.acknowledgedAt !== null);

  return (
    <>
      <PageHeader
        icon={BellIcon}
        iconColor={primary.hex}
        title="Alerts"
        actions={
          <Segmented
            aria-label="Show"
            options={SCOPES}
            value={showAll}
            onValueChange={setShowAll}
            size="sm"
          />
        }
      />

      <SearchField value={query} onValueChange={setQuery} placeholder="Search alerts" />

      <div className="flex items-center justify-between gap-3">
        <Segmented
          aria-label="Kind"
          options={KINDS}
          value={kind}
          onValueChange={setKind}
          size="sm"
        />
        {loading ? (
          <Skeleton className="h-3 w-16" />
        ) : (
          <p className="text-muted-foreground text-xs tabular-nums">
            {total} {showAll ? '' : 'active'}
          </p>
        )}
      </div>

      {error ? <Callout tone="destructive" title="Could not load alerts" description={error.message} /> : null}
      {ackError ? <Callout tone="destructive" title="Could not acknowledge" description={ackError} /> : null}

      {loading || turningPage ? <AlertListSkeleton /> : null}

      {!loading && !turningPage && list.length === 0 ? (
        <EmptyState
          icon={filtering ? MagnifyingGlassIcon : ShieldCheckIcon}
          title={filtering ? 'No matching alerts' : showAll ? 'No alerts yet' : 'All clear'}
          description={filtering ? 'Try a different search or kind.' : 'Readings are within the thresholds.'}
        />
      ) : null}

      {!turningPage && open.length > 0 ? (
        <section className="space-y-2">
          <h2 className="text-muted-foreground px-1 text-sm font-medium">Active</h2>
          <Card className="border-destructive/40 gap-0 divide-y overflow-hidden py-0">
            {open.map((alert) => {
              const spec = KIND[alert.kind];
              const KindIcon = spec.icon;
              const showDetails = expanded.has(alert.id);
              const canExpand = hasReading(alert);

              return (
                <div key={alert.id}>
                  <div className="flex items-center gap-3 px-4 py-3">
                    <span className="bg-destructive/10 text-destructive grid size-9 shrink-0 place-items-center rounded-full">
                      <KindIcon size={18} weight="fill" aria-hidden="true" />
                    </span>
                    <button
                      type="button"
                      disabled={!canExpand}
                      aria-expanded={canExpand ? showDetails : undefined}
                      onClick={() => toggle(alert.id)}
                      className="min-w-0 flex-1 cursor-pointer text-left disabled:cursor-default">
                      <span className="flex flex-wrap items-baseline gap-x-1.5">
                        <span className="text-sm font-semibold">{spec.title}</span>
                        <span className="text-destructive whitespace-nowrap text-sm font-semibold tabular-nums">
                          {alert.value.toFixed(1)} {spec.unit}
                        </span>
                        <span className="text-muted-foreground whitespace-nowrap text-xs">
                          limit {alert.threshold} {spec.unit}
                        </span>
                      </span>
                      <span className="text-muted-foreground mt-0.5 flex items-center gap-1 text-[11px]">
                        <time dateTime={alert.createdAt}>{formatShortDateTime(alert.createdAt)}</time>
                        {canExpand ? (
                          <CaretDownIcon
                            size={11}
                            weight="bold"
                            className={cn('transition-transform', showDetails && 'rotate-180')}
                            aria-hidden="true"
                          />
                        ) : null}
                      </span>
                    </button>
                    <Button size="sm" className="shrink-0" disabled={busy === alert.id} onClick={() => void acknowledge(alert.id)}>
                      <CheckCircleIcon weight="bold" aria-hidden="true" />
                      {busy === alert.id ? 'Acknowledging...' : 'Acknowledge'}
                    </Button>
                  </div>
                  {showDetails ? <MetricGrid m={alert} className="px-4 pb-3" /> : null}
                </div>
              );
            })}
          </Card>
        </section>
      ) : null}

      {!turningPage && handled.length > 0 ? (
        <SettingsSection title="Acknowledged">
          {handled.map((alert) => {
            const spec = KIND[alert.kind];
            const KindIcon = spec.icon;
            const showDetails = expanded.has(alert.id);
            const canExpand = hasReading(alert);

            return (
              <div key={alert.id}>
                <button
                  type="button"
                  disabled={!canExpand}
                  aria-expanded={canExpand ? showDetails : undefined}
                  onClick={() => toggle(alert.id)}
                  className="hover:bg-accent/60 flex w-full cursor-pointer items-center gap-3 px-4 py-3 text-left transition-colors disabled:cursor-default disabled:hover:bg-transparent">
                  <span className="bg-muted text-muted-foreground grid size-9 shrink-0 place-items-center rounded-full">
                    <KindIcon size={18} weight="bold" aria-hidden="true" />
                  </span>
                  {/* On a phone the time gets a line of its own, so the title and the
                      response line each have the full width; from sm up it sits to the right. */}
                  <span className="min-w-0 flex-1">
                    <span className="flex flex-wrap items-baseline gap-x-1.5">
                      <span className="text-sm font-semibold">{spec.title}</span>
                      <span className="text-muted-foreground whitespace-nowrap text-xs tabular-nums">
                        {alert.value.toFixed(1)} {spec.unit}
                      </span>
                    </span>
                    <span className="text-muted-foreground mt-0.5 block text-xs">{responseLabel(alert, nameOf)}</span>
                    <time dateTime={alert.createdAt} className="text-muted-foreground mt-0.5 block text-[11px] sm:hidden">
                      {formatShortDateTime(alert.createdAt)}
                    </time>
                  </span>
                  <time
                    dateTime={alert.createdAt}
                    className="text-muted-foreground hidden shrink-0 whitespace-nowrap text-right text-[11px] sm:block">
                    {formatShortDateTime(alert.createdAt)}
                  </time>
                  {canExpand ? (
                    <CaretDownIcon
                      size={12}
                      weight="bold"
                      className={cn('text-muted-foreground shrink-0 transition-transform', showDetails && 'rotate-180')}
                      aria-hidden="true"
                    />
                  ) : null}
                </button>
                {showDetails ? <MetricGrid m={alert} className="px-4 pb-3" /> : null}
              </div>
            );
          })}
        </SettingsSection>
      ) : null}

      {loading ? null : (
        <Pager
          total={total}
          limit={PAGE_SIZE}
          offset={offset}
          onOffsetChange={goToPage}
          noun="alert"
          // Lifts the jump field above the on-screen keyboard once it has opened.
          onInputFocus={() =>
            setTimeout(() => window.scrollTo({ top: document.documentElement.scrollHeight, behavior: 'smooth' }), 150)
          }
        />
      )}
    </>
  );
}
