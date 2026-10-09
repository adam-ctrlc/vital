import {
  LightningIcon,
  PauseIcon,
  PlayIcon,
  PlugsConnectedIcon,
  ThermometerIcon,
  WarningIcon,
  type Icon,
} from '@phosphor-icons/react';
import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react';
import { Link } from 'react-router';

import { PowerPanel } from '@/components/ac/power-panel';
import { AcWaveform } from '@/components/ac/waveform';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader } from '@/components/ui/card';
import { TileRow } from '@/components/ui/tile-row';
import { useAuth } from '@/features/auth/context';
import { greet } from '@/features/auth/greeting';
import * as readings from '@/features/readings/api';
import { merge, readBoard } from '@/features/readings/lan';
import { useNotifications } from '@/features/notifications/context';
import { usePoll } from '@/hooks/use-poll';
import { useAppearance, useColorScheme } from '@/lib/appearance';
import { formatLongDate } from '@/lib/datetime';
import { formatValue } from '@/lib/reading-format';

const HEARTBEAT_MS = 1000;

export default function DashboardScreen() {
  const { token, user } = useAuth();
  const { primary } = useAppearance();
  const { reportLive } = useNotifications();
  const { colorScheme } = useColorScheme();
  const isDark = colorScheme === 'dark';
  const ac = primary.hex;
  const amber = isDark ? '#fbbf24' : '#f59e0b';
  const danger = isDark ? '#f87171' : '#dc2626';

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
  const initials =
    `${user?.firstName?.[0] ?? ''}${user?.lastName?.[0] ?? ''}`.toUpperCase() ||
    (user?.username?.[0] ?? '?').toUpperCase();

  function renderSourceBadge() {
    if (!data) return null;
    switch (true) {
      case data.simulated:
        return (
          <Badge variant="secondary">
            Simulated
          </Badge>
        );
      case data.connected:
        return (
          <Badge>
            ESP32 live
          </Badge>
        );
      default:
        return (
          <Badge variant="outline" className="opacity-60">
            ESP32 offline
          </Badge>
        );
    }
  }

  return (
    <>
      {/* Settings, appearance, help and sign out live in Profile and Settings; this page
          is for the transformer. The avatar is the way there. */}
      <header className="flex items-start justify-between gap-3">
        <div className="min-w-0 space-y-0.5">
          <p className="text-muted-foreground text-xs font-medium">{formatLongDate()}</p>
          <h1 className="text-2xl font-bold leading-tight tracking-tight">{greeting}</h1>
          <p className="text-muted-foreground text-xs">{subtitle}</p>
        </div>
        <Link
          to="/profile"
          aria-label="Profile"
          className="grid size-10 shrink-0 place-items-center rounded-full text-sm font-bold transition-opacity hover:opacity-80"
          style={{ backgroundColor: `${ac}1f`, color: ac }}>
          {initials}
        </Link>
      </header>

      <Card className={overload ? 'border-destructive' : undefined}>
        <CardHeader className="gap-2 pb-0">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <CardDescription className="flex items-center gap-1.5 whitespace-nowrap font-medium">
              <LightningIcon size={14} weight="fill" color={ac} aria-hidden="true" />
              1 kVA transformer
            </CardDescription>
            <div className="flex items-center gap-1.5">
              {renderSourceBadge()}
              {/* The contacts, not the condition. A transformer reading NORMAL with
                  the load disconnected is a very different situation from one reading
                  NORMAL with the load running, and the two looked identical here. */}
              {data && data.relayClosed !== null && data.relayClosed !== undefined ? (
                <Badge variant={data.relayClosed ? 'secondary' : 'destructive'}>
                  {data.relayClosed ? 'LOAD ON' : 'LOAD OFF'}
                </Badge>
              ) : null}
              <Badge variant={overload ? 'destructive' : 'default'}>
                {overload ? 'OVERLOAD' : 'NORMAL'}
              </Badge>
            </div>
          </div>
          <div className="flex items-end gap-2">
            <span
              className="text-5xl font-bold leading-none tabular-nums"
              style={{ color: overload ? danger : ac }}>
              {formatValue(data ? data.apparentPowerVa : undefined, 0)}
            </span>
            {data && data.apparentPowerVa !== null ? (
              <span className="text-muted-foreground pb-1 text-lg">VA</span>
            ) : null}
            <span className="text-muted-foreground ml-auto pb-1 text-sm">
              {data && data.loadPercent !== null
                ? `${data.loadPercent.toFixed(0)}% of ${data.loadThresholdVa} VA`
                : ''}
            </span>
          </div>
        </CardHeader>
        <CardContent className="relative h-[150px] pb-0 pt-3">
          {/* On the waveform it controls, rather than in a toolbar far from it. */}
          <Button
            variant="ghost"
            size="icon"
            className="bg-card/80 absolute right-4 top-2 z-10 size-7 rounded-full backdrop-blur"
            aria-label={animate ? 'Pause the waveform' : 'Play the waveform'}
            aria-pressed={!animate}
            onClick={() => setAnimate((value) => !value)}>
            {animate ? <PauseIcon weight="fill" aria-hidden="true" /> : <PlayIcon weight="fill" aria-hidden="true" />}
          </Button>
          <AcWaveform
            // Flat with no reading, so "No data" does not look like a calm transformer.
            energized={data?.apparentPowerVa != null}
            animated={animate}
            voltageV={data?.voltageV}
            loadRatio={
              data && data.apparentPowerVa !== null && data.loadThresholdVa > 0
                ? data.apparentPowerVa / data.loadThresholdVa
                : null
            }
            powerFactor={data?.powerFactor}
            overload={overload}
            voltageColor={ac}
            currentColor={amber}
            dangerColor={danger}
            temperatureC={data?.temperatureC}
            tempLimitC={data?.tempThresholdC}
            tempColors={isDark ? { cool: '#4ade80', warm: '#facc15' } : { cool: '#22c55e', warm: '#eab308' }}
          />
        </CardContent>
      </Card>

      <TileRow
        tiles={[
          {
            icon: PlugsConnectedIcon,
            label: 'Current',
            value: formatValue(data ? data.currentA : undefined, 2),
            unit: 'A',
            hint: 'Line draw',
            iconColor: ac,
          },
          {
            icon: LightningIcon,
            label: 'Voltage',
            value: formatValue(data ? data.voltageV : undefined, 1),
            unit: 'V',
            hint: 'Supply',
            iconColor: ac,
          },
          {
            icon: ThermometerIcon,
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
        <Warning icon={WarningIcon} color={danger} title="Relay may be stuck">
          The relay reports open, but {formatValue(data?.currentA ?? null, 2)} A is still
          flowing. Treat the load as live and check the contacts.
        </Warning>
      ) : null}

      {hot ? (
        <Warning icon={ThermometerIcon} color={danger} title="Temperature warning">
          {data && data.temperatureC !== null
            ? `${data.temperatureC.toFixed(1)} °C is above the ${data.tempThresholdC} °C threshold.`
            : ''}
        </Warning>
      ) : null}

      <PowerPanel data={data} accent={ac} />

      {error ? (
        <Card className="gap-1 p-3" role="alert">
          <p className="text-destructive text-sm font-semibold">Cannot reach the API</p>
          <p className="text-muted-foreground text-xs">{error.message}</p>
        </Card>
      ) : null}

    </>
  );
}

/** A tinted warning panel: an icon in a circle, a title and a line of detail. */
function Warning({
  icon: WarningGlyph,
  color,
  title,
  children,
}: {
  icon: Icon;
  color: string;
  title: string;
  children: ReactNode;
}) {
  return (
    <div
      role="alert"
      className="flex items-center gap-3 rounded-xl border p-3"
      style={{ borderColor: `${color}40`, backgroundColor: `${color}14` }}>
      <span
        className="grid size-9 shrink-0 place-items-center rounded-full"
        style={{ backgroundColor: `${color}26` }}>
        <WarningGlyph size={18} weight="fill" color={color} aria-hidden="true" />
      </span>
      <div className="min-w-0 flex-1 space-y-0.5">
        <p className="text-sm font-semibold" style={{ color }}>
          {title}
        </p>
        <p className="text-muted-foreground text-xs">{children}</p>
      </div>
    </div>
  );
}
