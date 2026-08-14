import Slider from '@react-native-community/slider';
import { useColorScheme } from 'nativewind';
import Power from 'phosphor-react-native/src/icons/Power';
import Warning from 'phosphor-react-native/src/icons/Warning';
import { useCallback, useEffect, useState } from 'react';
import { View } from 'react-native';

import { Badge } from '@/components/ui/badge';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Segmented } from '@/components/ui/segmented';
import { Skeleton } from '@/components/ui/skeleton';
import { Text } from '@/components/ui/text';
import { useAuth } from '@/features/auth/context';
import * as deviceApi from '@/features/device/api';
import type { DeviceStatus } from '@/features/device/types';
import * as readingsApi from '@/features/readings/api';
import * as settingsApi from '@/features/settings/api';
import {
  DEFAULT_SECONDS,
  MAX_SECONDS,
  MIN_SECONDS,
  STEP_SECONDS,
  TICKS,
  formatDelay,
} from '@/features/settings/reclose-delay';
import {
  TRIP_DEFAULT_SECONDS,
  TRIP_MAX_SECONDS,
  TRIP_MIN_SECONDS,
  TRIP_STEP_SECONDS,
  TRIP_TICKS,
} from '@/features/settings/trip-delay';
import type { Settings } from '@/features/settings/types';
import { useAppearance } from '@/lib/appearance';

const POLL_MS = 5000;

const RELAY_OPTIONS: { label: string; value: 'closed' | 'open' }[] = [
  { label: 'On', value: 'closed' },
  { label: 'Off', value: 'open' },
];

/**
 * The contactor, on its own rather than buried in the device telemetry.
 *
 * It was inside the ESP32 card, which put the one control that switches a transformer
 * next to the Wi-Fi signal strength. The relay is not a property of the board; it is
 * the thing the whole system exists to operate.
 */
export function RelayCard() {
  const { token } = useAuth();
  const { primary } = useAppearance();
  const { colorScheme } = useColorScheme();
  const isDark = colorScheme === 'dark';
  const muted = isDark ? '#a1a1aa' : '#71717a';
  const danger = isDark ? '#f87171' : '#dc2626';

  const [status, setStatus] = useState<DeviceStatus | null>(null);
  const [overload, setOverload] = useState(false);
  const [current, setCurrent] = useState<number | null>(null);
  /** Whether the board is still posting. The only thing the buttons are gated on. */
  const [connected, setConnected] = useState(false);
  const [loading, setLoading] = useState(true);
  const [sending, setSending] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);
  /** The saved settings, kept whole because the endpoint takes every field together. */
  const [settings, setSettings] = useState<Settings | null>(null);
  /** The live value while the thumb is held, so the readout matches what is under it. */
  const [dragSeconds, setDragSeconds] = useState<number | null>(null);
  /** The same, for the trip slider. Separate so dragging one cannot move the other. */
  const [dragTrip, setDragTrip] = useState<number | null>(null);

  const load = useCallback(async () => {
    try {
      // Both, because the position comes from the board's telemetry and whether it
      // ought to move comes from the reading.
      const [device, live, current] = await Promise.all([
        deviceApi.status(token ?? ''),
        readingsApi.latest(token ?? ''),
        settingsApi.read(token ?? ''),
      ]);

      setStatus(device);
      setSettings(current);
      setOverload(live.status === 'overload' || live.overTemperature);
      setCurrent(live.currentA);
      setConnected(live.connected);
    } catch {
      // Left as it was; the poll tries again.
    } finally {
      setLoading(false);
    }
  }, [token]);

  useEffect(() => {
    void load();
    const id = setInterval(() => void load(), POLL_MS);

    return () => clearInterval(id);
  }, [load]);

  async function send(command: 'open' | 'close') {
    setSending(command);
    setNote(null);
    try {
      await deviceApi.relay(token ?? '', command);
      // Not "done". The board has to come and ask, which it does every few seconds
      // while the relay is open. Reporting a transformer as energised before it is
      // would be the worst kind of wrong.
      setNote(
        command === 'close'
          ? 'Sent. The board closes the relay on its next check, within a few seconds.'
          : 'Sent. The board opens the relay on its next check, within a few seconds.'
      );
      await load();
    } catch (caught) {
      setNote((caught as Error).message);
    } finally {
      setSending(null);
    }
  }

  // Three states, not two. Undefined is what a board that has never reported a position
  // gives, and reading that as closed was a lie in the safest-sounding direction: it
  // claimed the supply was reaching the load when nothing had said so.
  /**
   * Saves the delay on its own, by sending the thresholds back unchanged alongside it.
   *
   * The settings endpoint takes every field together, so a partial save is not on offer
   * and sending the current values is what keeps this from clearing them.
   */
  async function saveTimings(next: { reclose?: number; trip?: number }) {
    if (!settings) return;

    try {
      const result = await settingsApi.update(
        token ?? '',
        settings.loadThresholdVa,
        settings.tripThresholdVa,
        settings.tempThresholdC,
        next.reclose ?? settings.recloseDelaySeconds,
        next.trip ?? settings.tripConfirmSeconds
      );
      setSettings(result);
    } catch (caught) {
      setNote((caught as Error).message);
      // Put both back to what the server still holds, rather than leaving a thumb
      // showing a value that was refused.
      setDragSeconds(null);
      setDragTrip(null);
    }
  }

  const delay = settings?.recloseDelaySeconds ?? DEFAULT_SECONDS;
  const trip = settings?.tripConfirmSeconds ?? TRIP_DEFAULT_SECONDS;
  const position = status?.relayClosed;
  const open = position === false;
  const unknown = position === null || position === undefined;
  const lockedOut = status?.relayLockedOut ?? false;
  // One condition: the board is still posting. Nothing about the load, the position or
  // the lockout gates the buttons any more.
  //
  // Every version of this that reasoned about state got somebody stuck, because the
  // facts it reasoned from arrive by different routes and disagree exactly when things
  // are going wrong. The position comes from the newest hardware reading and the
  // lockout from the heartbeat, and a board whose meter has stopped answering posts no
  // readings at all, so the position freezes while the heartbeat keeps reporting the
  // truth. That combination showed "Locked out" with both buttons greyed out: the one
  // screen that can release it, refusing to.
  //
  // Nothing was gained by being clever. The protection does not live here: an overload
  // opens the contacts on the board regardless of what this screen offers, so a button
  // enabled at an unhelpful moment costs a wasted tap, while one disabled at the wrong
  // moment costs somebody a trip to the panel.
  const canControl = connected;
  // Contacts reported open with current still flowing. One of those is wrong, and the
  // measurement is the one with evidence behind it.
  const stuck = open && (current ?? 0) >= 0.15;

  return (
    <View className="gap-2">
      <Card className="gap-0 py-0">
        <CardHeader className="border-border flex-row items-center justify-between border-b p-4">
          <View className="flex-1 gap-0.5">
            <CardTitle className="text-base">Relay</CardTitle>
            <Text variant="muted" className="text-xs">
              The contactor between the supply and the load.
            </Text>
          </View>
          {loading ? (
            <Skeleton className="h-6 w-20" />
          ) : (
            <Badge
              variant={unknown ? 'outline' : open ? 'destructive' : 'secondary'}
              className="h-6">
              <Text>{unknown ? 'UNKNOWN' : open ? 'OPEN' : 'CLOSED'}</Text>
            </Badge>
          )}
        </CardHeader>

        <CardContent className="gap-3 p-4">
          <View className="flex-row items-center gap-2">
            <Power size={16} weight="fill" color={open ? danger : primary.hex} />
            {/* The relay's position, not a claim about what is plugged into it. A closed
                relay means the supply can reach the load; whether anything is drawing
                from it is what the current reading says, and that is a separate fact. */}
            <Text className="flex-1 text-sm font-medium" style={open ? { color: danger } : undefined}>
              {unknown
                ? 'Position unknown'
                : lockedOut
                  ? 'Locked out'
                  : open
                    ? 'Supply cut'
                    : 'Supply connected'}
            </Text>
          </View>

          {/* Ordered by what stops you acting, then by what the relay is doing. Not
              reporting comes first because it is the only state where the buttons will
              not do anything, and saying so beats a greyed out control with no reason
              attached. */}
          <Text variant="muted" className="text-xs leading-4">
            {!connected
              ? 'The board is not reporting, so the relay position is unknown rather than assumed. It could have tripped or been switched off since it was last heard from. The buttons stay off until it checks in again.'
              : unknown
                ? 'The board has not reported the relay position. Older firmware does not send it, and neither does the simulator.'
                : lockedOut
                  ? 'The relay is being held open and will not close on its own, either because the board ran out of reclose attempts or because someone opened it from here. Check the transformer, then close it below when it is safe.'
                  : open
                    ? 'The board will try to close it again on its own once the load is back within limits.'
                    : overload
                      ? 'The supply is over a limit. You can cut it now rather than waiting for the board to.'
                      : 'The supply can reach the load. Whether anything is drawing from it is a separate question, and the current reading answers that.'}
          </Text>

          {stuck ? (
            <View
              className="flex-row items-center gap-2 rounded-lg border p-2"
              style={{ borderColor: `${danger}40`, backgroundColor: `${danger}14` }}>
              <Warning size={14} weight="fill" color={danger} />
              <Text className="flex-1 text-[11px] leading-4" style={{ color: danger }}>
                Reported open with {current?.toFixed(2)} A still flowing. Treat the load as
                live and check the contacts.
              </Text>
            </View>
          ) : null}

          {/* The same control the data source uses, because it is the same kind of
              choice: two states, one of them current. Two buttons implied two actions
              when there is really one setting with a position. */}
          {loading ? (
            <Skeleton className="h-11 w-full rounded-full" />
          ) : (
            <Segmented
              // Disabled per option, which is what Segmented offers, and better anyway:
              // the row still shows which position the relay is in when there is
              // nothing to change, rather than greying out the answer along with the
              // control.
              options={RELAY_OPTIONS.map((option) => ({
                ...option,
                disabled: !canControl || sending !== null,
              }))}
              value={open ? 'open' : 'closed'}
              onChange={(next) => void send(next === 'closed' ? 'close' : 'open')}
              activeColor={open ? danger : primary.hex}
              inactiveColor={muted}
              variant="solid"
              fill
            />
          )}

          {note ? (
            <Text variant="muted" className="text-[11px] leading-4">
              {note}
            </Text>
          ) : null}

          <View className="border-border gap-1 border-t pt-3">
            <View className="flex-row items-baseline justify-between">
              <Text className="text-sm font-medium">Trip delay</Text>
              <Text variant="muted" className="text-[10px]">
                {formatDelay(dragTrip ?? trip)}
              </Text>
            </View>
            <Text variant="muted" className="text-xs leading-4">
              How long the load has to stay over the trip threshold before the relay
              opens. Shorter cuts a real fault sooner; longer rides out a brief surge
              without dropping the load.
            </Text>
            <Slider
              minimumValue={TRIP_MIN_SECONDS}
              maximumValue={TRIP_MAX_SECONDS}
              step={TRIP_STEP_SECONDS}
              value={trip}
              disabled={!settings}
              minimumTrackTintColor={primary.hex}
              maximumTrackTintColor={muted}
              thumbTintColor={primary.hex}
              onValueChange={(seconds) => setDragTrip(Math.round(seconds))}
              onSlidingComplete={(seconds) => {
                void saveTimings({ trip: Math.round(seconds) });
                setDragTrip(null);
              }}
            />
            <View className="-mt-1 flex-row justify-between px-2">
              {TRIP_TICKS.map((seconds) => (
                <View
                  key={seconds}
                  className="w-px rounded-full"
                  style={{
                    height: 6,
                    backgroundColor: seconds <= (dragTrip ?? trip) ? primary.hex : muted,
                    opacity: seconds <= (dragTrip ?? trip) ? 0.9 : 0.35,
                  }}
                />
              ))}
            </View>
          </View>

          <View className="border-border gap-1 border-t pt-3">
            <View className="flex-row items-baseline justify-between">
              <Text className="text-sm font-medium">Reclose delay</Text>
              <Text variant="muted" className="text-[10px]">
                {formatDelay(dragSeconds ?? delay)}
              </Text>
            </View>
            <Text variant="muted" className="text-xs leading-4">
              How long the load stays off before the board tries again. Three attempts,
              then it stops trying and holds the relay open until an admin closes it.
            </Text>
            <Slider
              minimumValue={MIN_SECONDS}
              maximumValue={MAX_SECONDS}
              step={STEP_SECONDS}
              value={delay}
              disabled={!settings}
              minimumTrackTintColor={primary.hex}
              maximumTrackTintColor={muted}
              thumbTintColor={primary.hex}
              // The readout follows the thumb; the save waits for release, so a drag
              // writes one value rather than one per notch crossed.
              onValueChange={(seconds) => setDragSeconds(Math.round(seconds))}
              onSlidingComplete={(seconds) => {
                void saveTimings({ reclose: Math.round(seconds) });
                setDragSeconds(null);
              }}
            />
            <View className="-mt-1 flex-row justify-between px-2">
              {TICKS.map((seconds) => (
                <View
                  key={seconds}
                  className="w-px rounded-full"
                  style={{
                    height: 6,
                    backgroundColor: seconds <= (dragSeconds ?? delay) ? primary.hex : muted,
                    opacity: seconds <= (dragSeconds ?? delay) ? 0.9 : 0.35,
                  }}
                />
              ))}
            </View>
          </View>

          <Text variant="muted" className="text-[10px] leading-4">
            Neither button defeats the protection. An overload re-opens the contacts a few
            seconds later whoever closed them.
          </Text>
        </CardContent>
      </Card>
    </View>
  );
}
