import { useColorScheme } from 'nativewind';
import Info from 'phosphor-react-native/src/icons/Info';
import Lightning from 'phosphor-react-native/src/icons/Lightning';
import Palette from 'phosphor-react-native/src/icons/Palette';
import PlugsConnected from 'phosphor-react-native/src/icons/PlugsConnected';
import Pulse from 'phosphor-react-native/src/icons/Pulse';
import SignOut from 'phosphor-react-native/src/icons/SignOut';
import Thermometer from 'phosphor-react-native/src/icons/Thermometer';
import Warning from 'phosphor-react-native/src/icons/Warning';
import { useCallback, useEffect, useRef, useState } from 'react';
import { ScrollView, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

import { TileRow } from '@/components/ui/tile-row';
import { PowerPanel } from '@/components/ac/power-panel';
import { AcWaveform } from '@/components/ac/waveform';
import { AppearanceModal } from '@/components/appearance-modal';
import { ConfirmModal } from '@/components/confirm-modal';
import { InfoModal } from '@/components/info-modal';
import { ThemeToggle } from '@/components/theme-toggle';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader } from '@/components/ui/card';
import { Text } from '@/components/ui/text';
import { useAuth } from '@/features/auth/context';
import { greet } from '@/features/auth/greeting';
import * as readings from '@/features/readings/api';
import { merge, readBoard } from '@/features/readings/lan';
import { usePoll } from '@/hooks/use-poll';
import { useNotifications } from '@/features/notifications/context';
import { useAppearance } from '@/lib/appearance';
import { formatValue } from '@/lib/reading-format';

const HEARTBEAT_MS = 1000;

export default function DashboardScreen() {
  const { token, user, signOut } = useAuth();
  const { primary } = useAppearance();
  const { reportLive } = useNotifications();
  const { colorScheme } = useColorScheme();
  const isDark = colorScheme === 'dark';
  const ac = primary.hex;
  const amber = isDark ? '#fbbf24' : '#f59e0b';
  const danger = isDark ? '#f87171' : '#dc2626';
  const fg = isDark ? '#fafafa' : '#0a0a0a';
  const muted = isDark ? '#a1a1aa' : '#71717a';

  const [showAppearance, setShowAppearance] = useState(false);
  const [showInfo, setShowInfo] = useState(false);
  const [showSignOut, setShowSignOut] = useState(false);
  const [animate, setAnimate] = useState(true);

  /**
   * The board's address, remembered between polls.
   *
   * Learned from the backend, which is the only thing that knows it, and then used
   * without asking again. Held in a ref rather than state because changing it must not
   * rebuild the fetcher and restart the poll.
   */
  const boardIp = useRef<string | null>(null);

  /**
   * Backend first, then the board itself when it is reachable.
   *
   * The backend answer is authoritative about everything that is not a measurement:
   * the thresholds, the source mode, whether the board is considered connected. The
   * board is authoritative about the measurements, and is seconds fresher, because the
   * backend's copy has been through a post and a database write to get there.
   *
   * Reached for only on a shared network, so this is the exception rather than the
   * rule, and every failure falls back silently to what the backend said.
   */
  const fetcher = useCallback(
    async (signal: AbortSignal) => {
      const base = await readings.latest(token ?? '', signal);

      if (base.deviceIp) boardIp.current = base.deviceIp;

      const ip = boardIp.current;
      if (!ip || base.simulated) return base;

      const board = await readBoard(ip, signal);

      return board ? merge(base, board) : base;
    },
    [token]
  );
  const { data, error } = usePoll(fetcher, HEARTBEAT_MS, Boolean(token));

  // Straight from the poll to the alarm. This is the shortest path there is: the number
  // on screen and the noise come from the same reading, so they cannot disagree, and
  // nothing waits on the backend noticing what the screen can already see.
  useEffect(() => {
    reportLive(data);
  }, [data, reportLive]);

  const overload = data?.status === 'overload';
  // A tenth of an amp is noise; this is well above it and well below any real load.
  const contactsDisagree =
    data?.relayClosed === false && (data.currentA ?? 0) >= 0.15;
  const hot = data?.overTemperature ?? false;

  // Recomputed each heartbeat, so the greeting rolls over with the clock.
  const { greeting, subtitle } = greet(user);

  // The source and status badges sit side by side, so their height is pinned rather
  // than left to each variant's intrinsic text height: outline draws a visible border
  // where the filled variants draw a transparent one, and the two were not landing on
  // the same total. A fixed height makes them match whatever the variant does.
  const BADGE = 'h-6';

  function renderSourceBadge() {
    if (!data) return null;
    switch (true) {
      case data.simulated:
        return (
          <Badge variant="secondary" className={BADGE}>
            <Text>Simulated</Text>
          </Badge>
        );
      case data.connected:
        return (
          <Badge className={BADGE}>
            <Text>ESP32 live</Text>
          </Badge>
        );
      default:
        return (
          <Badge variant="outline" className={`${BADGE} opacity-60`}>
            <Text>ESP32 offline</Text>
          </Badge>
        );
    }
  }

  return (
    <SafeAreaView className="bg-background flex-1" edges={['top']}>
      <ScrollView contentContainerClassName="gap-4 p-4 pb-8">
        <View className="gap-2">
          <View className="flex-row items-center justify-between gap-2">
            <View className="flex-row items-center gap-1.5">
              <Lightning size={14} weight="fill" color={ac} />
              <Text variant="muted" className="text-[10px] uppercase tracking-wide">
                1 KVA Transformer
              </Text>
            </View>
            <View className="border-border bg-muted/40 dark:bg-input/30 flex-row items-center rounded-full border p-0.5">
              <Button
                variant="ghost"
                size="icon"
                className="h-8 w-8 rounded-full"
                accessibilityLabel="How it works"
                onPress={() => setShowInfo(true)}>
                <Info size={16} weight="bold" color={fg} />
              </Button>
              <Button
                variant="ghost"
                size="icon"
                className="h-8 w-8 rounded-full"
                accessibilityLabel="Appearance"
                onPress={() => setShowAppearance(true)}>
                <Palette size={16} weight="bold" color={fg} />
              </Button>
              <Button
                variant="ghost"
                size="icon"
                className="h-8 w-8 rounded-full"
                accessibilityRole="switch"
                accessibilityState={{ checked: animate }}
                accessibilityLabel="Toggle waveform animation"
                onPress={() => setAnimate((value) => !value)}>
                <Pulse size={16} weight="bold" color={animate ? ac : muted} />
              </Button>
              <ThemeToggle />
              <View className="bg-border h-4 w-px" />
              <Button
                variant="ghost"
                size="icon"
                className="h-8 w-8 rounded-full"
                accessibilityLabel="Sign out"
                onPress={() => setShowSignOut(true)}>
                <SignOut size={16} weight="bold" color={fg} />
              </Button>
            </View>
          </View>

          <View className="gap-0.5">
            <Text className="text-2xl font-bold leading-tight">{greeting}</Text>
            <Text variant="muted" className="text-xs">
              {subtitle}
            </Text>
          </View>
        </View>

        <Card className={overload ? 'border-destructive' : undefined}>
          <CardHeader className="gap-2 pb-0">
            <View className="flex-row items-center justify-between">
              <CardDescription>Status</CardDescription>
              <View className="flex-row items-center gap-1.5">
                {renderSourceBadge()}
                {/* The contacts, not the condition. A transformer reading NORMAL with
                    the load disconnected is a very different situation from one reading
                    NORMAL with the load running, and the two looked identical here. */}
                {data && data.relayClosed !== null && data.relayClosed !== undefined ? (
                  <Badge
                    variant={data.relayClosed ? 'secondary' : 'destructive'}
                    className={BADGE}>
                    <Text>{data.relayClosed ? 'LOAD ON' : 'LOAD OFF'}</Text>
                  </Badge>
                ) : null}
                <Badge variant={overload ? 'destructive' : 'default'} className={BADGE}>
                  <Text>{overload ? 'OVERLOAD' : 'NORMAL'}</Text>
                </Badge>
              </View>
            </View>
            <View className="flex-row items-end gap-2">
              <Text
                className="text-5xl font-bold leading-none"
                style={{ color: overload ? danger : ac }}>
                {formatValue(data ? data.apparentPowerVa : undefined, 0)}
              </Text>
              {data && data.apparentPowerVa !== null ? (
                <Text variant="muted" className="pb-1 text-lg">
                  VA
                </Text>
              ) : null}
              <Text variant="muted" className="ml-auto pb-1 text-sm">
                {data && data.loadPercent !== null
                  ? `${data.loadPercent.toFixed(0)}% of ${data.loadThresholdVa} VA`
                  : ''}
              </Text>
            </View>
          </CardHeader>
          <CardContent className="pb-0 pt-3" style={{ height: 150 }}>
            <AcWaveform
              energized={Boolean(data)}
              animated={animate}
              voltageColor={overload ? danger : ac}
              currentColor={amber}
            />
          </CardContent>
        </Card>

        <TileRow
          tiles={[
            {
              icon: PlugsConnected,
              label: 'Current',
              value: formatValue(data ? data.currentA : undefined, 2),
              unit: 'A',
              hint: 'Line draw',
              iconColor: ac,
            },
            {
              icon: Lightning,
              label: 'Voltage',
              value: formatValue(data ? data.voltageV : undefined, 1),
              unit: 'V',
              hint: 'Supply',
              iconColor: ac,
            },
            {
              icon: Thermometer,
              label: 'Temperature',
              value: formatValue(data ? data.temperatureC : undefined, 1),
              unit: '°C',
              // The limit rather than a label: a temperature means little without the
              // number it is judged against, and that number is adjustable.
              hint: data ? `Limit ${data.tempThresholdC} °C` : undefined,
              iconColor: hot ? danger : ac,
            },
          ]}
        />

        {/* Current flowing through contacts that are meant to be open. The board says
            the relay is off, the meter says the load is still drawing, and only one of
            them can be right: the reading is a measurement and the state is a belief,
            so the reading wins. Usually a welded contact, which is the failure that
            makes a protection scheme decorative. */}
        {contactsDisagree ? (
          <View
            className="flex-row items-center gap-3 rounded-xl border p-3"
            style={{ borderColor: `${danger}40`, backgroundColor: `${danger}14` }}>
            <View
              className="h-9 w-9 items-center justify-center rounded-full"
              style={{ backgroundColor: `${danger}26` }}>
              <Warning size={18} weight="fill" color={danger} />
            </View>
            <View className="flex-1 gap-0.5">
              <Text className="text-sm font-semibold" style={{ color: danger }}>
                Relay may be stuck
              </Text>
              <Text variant="muted" className="text-xs">
                The relay reports open, but {formatValue(data?.currentA ?? null, 2)} A is
                still flowing. Treat the load as live and check the contacts.
              </Text>
            </View>
          </View>
        ) : null}

        {hot ? (
          <View
            className="flex-row items-center gap-3 rounded-xl border p-3"
            style={{ borderColor: `${danger}40`, backgroundColor: `${danger}14` }}>
            <View
              className="h-9 w-9 items-center justify-center rounded-full"
              style={{ backgroundColor: `${danger}26` }}>
              <Thermometer size={18} weight="fill" color={danger} />
            </View>
            <View className="flex-1 gap-0.5">
              <Text className="text-sm font-semibold" style={{ color: danger }}>
                Temperature warning
              </Text>
              <Text variant="muted" className="text-xs">
                {data && data.temperatureC !== null
                  ? `${data.temperatureC.toFixed(1)} °C is above the ${data.tempThresholdC} °C threshold.`
                  : ''}
              </Text>
            </View>
          </View>
        ) : null}

        <PowerPanel data={data} accent={ac} />

        {error ? (
          <Card className="py-0">
            <CardContent className="gap-1 p-3">
              <Text className="text-destructive text-sm font-semibold">Cannot reach the API</Text>
              <Text variant="muted" className="text-xs">
                {error.message}
              </Text>
            </CardContent>
          </Card>
        ) : null}

      </ScrollView>

      <AppearanceModal visible={showAppearance} onClose={() => setShowAppearance(false)} />
      <InfoModal visible={showInfo} onClose={() => setShowInfo(false)} />
      <ConfirmModal
        visible={showSignOut}
        title="Sign out?"
        message="You will need your email and password to sign back in."
        confirmLabel="Sign out"
        destructive
        onConfirm={() => {
          setShowSignOut(false);
          void signOut();
        }}
        onClose={() => setShowSignOut(false)}
      />
    </SafeAreaView>
  );
}
