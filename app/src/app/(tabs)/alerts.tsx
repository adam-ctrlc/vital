import { useColorScheme } from 'nativewind';
import Bell from 'phosphor-react-native/src/icons/Bell';
import BellRinging from 'phosphor-react-native/src/icons/BellRinging';
import FunnelSimple from 'phosphor-react-native/src/icons/FunnelSimple';
import ListBullets from 'phosphor-react-native/src/icons/ListBullets';
import MagnifyingGlass from 'phosphor-react-native/src/icons/MagnifyingGlass';
import ShieldCheck from 'phosphor-react-native/src/icons/ShieldCheck';
import Thermometer from 'phosphor-react-native/src/icons/Thermometer';
import Warning from 'phosphor-react-native/src/icons/Warning';
import { useCallback, useEffect, useRef, useState } from 'react';
import { KeyboardAvoidingView, ScrollView, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

import { AlertListSkeleton } from '@/components/ac/alert-skeleton';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import { EmptyState } from '@/components/ui/empty-state';
import { Pager } from '@/components/ui/pager';
import { SearchField } from '@/components/ui/search-field';
import { Segmented } from '@/components/ui/segmented';
import { Skeleton } from '@/components/ui/skeleton';
import { Text } from '@/components/ui/text';
import * as alertsApi from '@/features/alerts/api';
import type { Alert, AlertKind } from '@/features/alerts/types';
import { useAuth } from '@/features/auth/context';
import { useDebounced } from '@/hooks/use-debounced';
import { usePoll } from '@/hooks/use-poll';
import { useAppearance } from '@/lib/appearance';
import { formatDateTime } from '@/lib/datetime';
import { PAGE_SIZE, type Page } from '@/lib/pagination';

const POLL_MS = 2000;

/** Matches `--primary-foreground`, which the appearance provider pins to white. */
const ON_PRIMARY = '#ffffff';

type PhosphorIcon = typeof Warning;

const KINDS: { label: string; value: AlertKind | null; icon: PhosphorIcon }[] = [
  { label: 'All kinds', value: null, icon: FunnelSimple },
  { label: 'Overload', value: 'overload', icon: Warning },
  { label: 'Temperature', value: 'temperature', icon: Thermometer },
];

/** Scope is a different axis from kind, so it gets its own control next to the list. */
const SCOPES = [
  { label: 'Active', value: false, icon: BellRinging },
  { label: 'All', value: true, icon: ListBullets },
];


export default function AlertsScreen() {
  const { token } = useAuth();
  const { primary } = useAppearance();
  const { colorScheme } = useColorScheme();
  const isDark = colorScheme === 'dark';
  const danger = isDark ? '#f87171' : '#dc2626';
  const muted = isDark ? '#a1a1aa' : '#71717a';
  const onPrimary = ON_PRIMARY;

  const [showAll, setShowAll] = useState(false);
  const [query, setQuery] = useState('');
  const [kind, setKind] = useState<AlertKind | null>(null);
  const [offset, setOffset] = useState(0);
  const [busy, setBusy] = useState<number | null>(null);
  const [ackError, setAckError] = useState<string | null>(null);
  const [nonce, setNonce] = useState(0);
  // While set, the list is held frozen so a just-acknowledged card shows its
  // acknowledged state for a beat before the refetch drops it.
  const [frozen, setFrozen] = useState<Alert[] | null>(null);

  const scroller = useRef<ScrollView>(null);
  const ackTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const debouncedQuery = useDebounced(query);

  // A narrowed result set can be shorter than the current offset, which would
  // land the pager on an empty page, so any filter change returns to page one.
  useEffect(() => {
    setOffset(0);
  }, [debouncedQuery, kind, showAll]);

  // Paging replaces every card, so staying scrolled down would land you in the
  // middle of alerts you have not seen.
  function goToPage(next: number) {
    setOffset(next);
    scroller.current?.scrollTo({ y: 0, animated: true });
  }

  const fetcher = useCallback(
    (signal: AbortSignal) =>
      alertsApi.list(
        token ?? '',
        {
          activeOnly: !showAll,
          q: debouncedQuery,
          kind: kind ?? undefined,
          limit: PAGE_SIZE,
          offset,
        },
        signal
      ),
    [token, showAll, debouncedQuery, kind, offset, nonce]
  );

  // Any filter change resets: the rows on screen no longer answer the new question.
  // Acknowledging only reloads, so one row changing does not blank the list.
  const { data, error } = usePoll<Page<Alert>>(fetcher, POLL_MS, Boolean(token), {
    resetKey: `${showAll}|${kind}|${debouncedQuery}|${offset}`,
    reloadKey: nonce,
  });

  const rows = data?.rows ?? [];
  // While frozen, render the held snapshot so the acknowledged card stays put.
  const list = frozen ?? rows;
  const total = data?.total ?? 0;

  async function acknowledge(id: number) {
    setBusy(id);
    setAckError(null);
    try {
      const updated = await alertsApi.acknowledge(token ?? '', id);
      // Swap the acknowledged card in place and hold the list for a moment, so the
      // "ACKNOWLEDGED" state is visible before the refetch removes it.
      setFrozen((current) => (current ?? rows).map((a) => (a.id === id ? updated : a)));

      if (ackTimer.current) clearTimeout(ackTimer.current);
      ackTimer.current = setTimeout(() => {
        setFrozen(null);
        setNonce((n) => n + 1);
      }, 2000);
    } catch (caught) {
      // Without this the card silently stays ACTIVE and the rejection escapes the
      // `void` at the call site. Losing the race to another engineer acknowledging
      // the same alert is the ordinary way to get here, not an edge case.
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

  return (
    <SafeAreaView className="bg-background flex-1" edges={['top']}>
      <KeyboardAvoidingView className="flex-1" behavior="padding">
      <ScrollView
        ref={scroller}
        contentContainerClassName="gap-3 p-4 pb-8"
        keyboardShouldPersistTaps="handled">
        <View className="flex-row items-center gap-2">
          <Bell size={22} weight="fill" color={primary.hex} />
          <Text className="text-lg font-bold">Alerts</Text>
        </View>

        <SearchField value={query} onChangeText={setQuery} placeholder="Search alerts..." />

        <View className="flex-row items-center gap-2">
          {KINDS.map((option) => {
            const selected = kind === option.value;
            const Icon = option.icon;
            return (
              <Button
                key={option.label}
                variant={selected ? 'default' : 'outline'}
                size="sm"
                className="flex-1 px-1"
                onPress={() => setKind(option.value)}>
                <Icon size={14} weight="bold" color={selected ? onPrimary : muted} />
                <Text className="text-xs">{option.label}</Text>
              </Button>
            );
          })}
        </View>

        {error ? <Text className="text-destructive text-sm">{error.message}</Text> : null}
        {ackError ? <Text className="text-destructive text-sm">{ackError}</Text> : null}

        <View className="flex-row items-center justify-between gap-2">
          {loading ? (
            <Skeleton className="h-3 w-32" />
          ) : (
            <Text variant="muted" className="flex-1 text-xs">
              {total} {showAll ? 'total' : 'active'} alert{total === 1 ? '' : 's'}
              {filtering ? ' matching filters' : ''}
            </Text>
          )}
          <Segmented
            options={SCOPES}
            value={showAll}
            onChange={setShowAll}
            activeColor={primary.hex}
            inactiveColor={muted}
          />
        </View>

        {loading ? <AlertListSkeleton /> : null}

        {!loading && list.length === 0 ? (
          <EmptyState
            icon={filtering ? MagnifyingGlass : ShieldCheck}
            title={filtering ? 'No matching alerts' : `No ${showAll ? '' : 'active '}alerts`}
            description={
              filtering
                ? 'Try a different search or kind.'
                : 'Conditions are within the configured thresholds.'
            }
          />
        ) : null}

        {(loading ? [] : list).map((alert) => {
          const open = alert.acknowledgedAt === null;
          const accent = open ? danger : muted;

          return (
            <Card key={alert.id} className="py-0">
              <CardContent className="gap-2 p-3">
                <View className="flex-row items-center justify-between">
                  <View className="flex-row items-center gap-1.5">
                    {alert.kind === 'temperature' ? (
                      <Thermometer size={14} weight="bold" color={accent} />
                    ) : (
                      <Warning size={14} weight="bold" color={accent} />
                    )}
                    <Text className="text-sm font-semibold capitalize leading-none">
                      {alert.kind}
                    </Text>
                  </View>
                  <Badge variant={open ? 'destructive' : 'secondary'}>
                    <Text className="text-[10px]">{open ? 'ACTIVE' : 'ACKNOWLEDGED'}</Text>
                  </Badge>
                </View>

                <View className="flex-row items-baseline gap-1.5">
                  <Text className="text-lg font-bold leading-none" style={{ color: accent }}>
                    {alert.value.toFixed(1)}
                  </Text>
                  <Text variant="muted" className="text-[10px]">
                    vs {alert.threshold} threshold
                  </Text>
                </View>

                <Text variant="muted" className="text-xs">
                  {alert.message}
                </Text>

                <View className="flex-row items-center justify-between gap-2">
                  <Text variant="muted" className="flex-1 text-[10px]">
                    {open
                      ? formatDateTime(alert.createdAt)
                      : `Responded in ${alert.responseMs === null ? '--' : `${(alert.responseMs / 1000).toFixed(1)}s`}`}
                  </Text>
                  {open ? (
                    <Button
                      size="sm"
                      className="h-8"
                      disabled={busy === alert.id}
                      onPress={() => void acknowledge(alert.id)}>
                      <Text className="text-xs">
                        {busy === alert.id ? 'Acknowledging...' : 'Acknowledge'}
                      </Text>
                    </Button>
                  ) : null}
                </View>
              </CardContent>
            </Card>
          );
        })}

        {loading ? null : (
          <Pager
            total={total}
            limit={PAGE_SIZE}
            offset={offset}
            onOffsetChange={goToPage}
            noun="alert"
            onInputFocus={() =>
              setTimeout(() => scroller.current?.scrollToEnd({ animated: true }), 150)
            }
          />
        )}
      </ScrollView>
      </KeyboardAvoidingView>
    </SafeAreaView>
  );
}
