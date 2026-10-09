import { PowerIcon, WarningIcon } from '@phosphor-icons/react';
import { useCallback, useEffect, useState } from 'react';

import { Badge } from '@/components/ui/badge';
import { Segmented } from '@/components/ui/segmented';
import { SettingsSection } from '@/components/ui/settings-list';
import { Skeleton } from '@/components/ui/skeleton';
import { useAuth } from '@/features/auth/context';
import * as deviceApi from '@/features/device/api';
import type { DeviceStatus } from '@/features/device/types';
import { relayWaitOutcome } from '@/features/device/relay-wait';
import * as readingsApi from '@/features/readings/api';
import { useAppearance, useColorScheme } from '@/lib/appearance';

const POLL_MS = 5000;

/**
 * How often to look while a command is in flight.
 *
 * The board acts on its next post, so the answer arrives within a posting interval.
 * Waiting out the ordinary poll would add up to five seconds of watching a disabled
 * button for a relay that had already moved.
 */
const AWAITING_POLL_MS = 1000;

/**
 * How long to keep waiting before letting go.
 *
 * The board might never act: it could be offline, or the close could be refused
 * because the protection undid one moments ago. Nothing would ever clear the wait in
 * those cases, and a button disabled forever is worse than one that admits defeat.
 *
 * Sized against the real path rather than the hoped-for one, and that path is longer
 * than it looks. The command reaches the board on the response to a post, and that
 * post was sent before the contacts moved, so it still describes the old position. The
 * new one only arrives on the following post: up to ten seconds, plus two round trips
 * to Tokyo, and another five if a post is lost.
 *
 * Thirty absorbs that. Giving up early is the failure that matters, because it tells
 * an operator the board is unreachable while it is quietly doing what they asked.
 */
const AWAITING_TIMEOUT_MS = 30000;

const RELAY_OPTIONS: { label: string; value: 'closed' | 'open' }[] = [
  { label: 'On', value: 'closed' },
  { label: 'Off', value: 'open' },
];

/**
 * The contactor: where it is, and the one control that switches the transformer. First
 * on the page because it is the thing an operator comes here to act on. Its timings live
 * with the thresholds under Protection, since they decide when the board acts, not this.
 */
export function RelaySection() {
  const { token } = useAuth();
  const { primary } = useAppearance();
  const { colorScheme } = useColorScheme();
  const isDark = colorScheme === 'dark';
  const danger = isDark ? '#f87171' : '#dc2626';

  const [status, setStatus] = useState<DeviceStatus | null>(null);
  const [overload, setOverload] = useState(false);
  const [current, setCurrent] = useState<number | null>(null);
  /** Whether the board is still posting. The only thing the buttons are gated on. */
  const [connected, setConnected] = useState(false);
  const [loading, setLoading] = useState(true);
  const [sending, setSending] = useState<string | null>(null);
  /**
   * The position asked for and not yet seen, with the moment to give up.
   *
   * `sending` only covers the request itself, which returns as soon as the backend has
   * written the command down. The board has not acted at that point, so re-enabling
   * there invites a second press against a relay that is still moving.
   */
  const [awaiting, setAwaiting] = useState<{ closed: boolean; until: number } | null>(null);
  const [note, setNote] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      // Both, because the position comes from the board's telemetry and whether it
      // ought to move comes from the reading.
      const [device, live] = await Promise.all([
        deviceApi.status(token ?? ''),
        readingsApi.latest(token ?? ''),
      ]);

      setStatus(device);
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
    const id = setInterval(() => void load(), awaiting ? AWAITING_POLL_MS : POLL_MS);

    return () => clearInterval(id);
  }, [load, awaiting]);

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
      setAwaiting({ closed: command === 'close', until: Date.now() + AWAITING_TIMEOUT_MS });
      await load();
    } catch (caught) {
      setNote((caught as Error).message);
      // Nothing was queued, so there is nothing to wait for.
      setAwaiting(null);
    } finally {
      setSending(null);
    }
  }

  // Released when the board reports the position that was asked for, or when waiting
  // any longer stops being honest.
  //
  // Watching the reported position rather than the request is the whole point: the
  // request only proves the backend wrote the command down. A relay that has actually
  // moved is the only thing worth re-enabling the buttons for.
  useEffect(() => {
    if (!awaiting) return;

    if (relayWaitOutcome(awaiting, status?.relayClosed, Date.now()) === 'moved') {
      setAwaiting(null);
      setNote(null);
      return;
    }

    // On a timer of its own rather than on the next poll. A poll that throws leaves the
    // status untouched, this effect never re-runs, and the deadline would pass unnoticed
    // with the buttons disabled for good. Losing the network is exactly when that is
    // most likely and least forgivable.
    const timer = setTimeout(
      () => {
        setAwaiting(null);
        setNote(
          'The board has not reported the change. It may be offline, or the close was refused because the protection undid one moments ago.'
        );
      },
      Math.max(0, awaiting.until - Date.now())
    );

    return () => clearTimeout(timer);
  }, [awaiting, status]);

  // Three states, not two. Undefined is what a board that has never reported a position
  // gives, and reading that as closed would claim the supply reaches the load when
  // nothing had said so.
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

  // One line, and only when it adds something the status above does not already say.
  // The longer reasoning is in the help sheet. Ordered by what stops you acting.
  const statusNote = !connected
    ? 'Board offline. Controls return when it reports.'
    : unknown
      ? 'The board has not reported the relay position.'
      : lockedOut
        ? 'Held open. Check the transformer, then close it when safe.'
        : open
          ? 'Closes again on its own once the load is within limits.'
          : overload
            ? 'Over a limit. You can cut the supply now.'
            : null;

  const tone = open ? danger : primary.hex;

  return (
    <SettingsSection title="Relay" footer={note}>
      <div className="flex items-center gap-3 p-4">
        <span
          className="grid size-10 shrink-0 place-items-center rounded-full"
          style={{ backgroundColor: `${tone}1f` }}>
          <PowerIcon size={20} weight="fill" color={tone} aria-hidden="true" />
        </span>
        <div className="min-w-0 flex-1">
          {/* The relay's position, not a claim about what is plugged into it. */}
          <p className="text-sm font-semibold" style={open ? { color: danger } : undefined}>
            {unknown
              ? 'Position unknown'
              : lockedOut
                ? 'Locked out'
                : open
                  ? 'Supply cut'
                  : 'Supply connected'}
          </p>
          {statusNote ? <p className="text-muted-foreground text-xs">{statusNote}</p> : null}
        </div>
        {loading ? (
          <Skeleton className="h-5 w-16 rounded-full" />
        ) : (
          <Badge variant={unknown ? 'outline' : open ? 'destructive' : 'secondary'}>
            {unknown ? 'UNKNOWN' : open ? 'OPEN' : 'CLOSED'}
          </Badge>
        )}
      </div>

      {stuck ? (
        <div className="flex items-center gap-2 p-4" style={{ backgroundColor: `${danger}14`, color: danger }}>
          <WarningIcon size={14} weight="fill" aria-hidden="true" />
          <p className="flex-1 text-xs">
            Open, but {current?.toFixed(2)} A is still flowing. Check the contacts.
          </p>
        </div>
      ) : null}

      <div className="p-4">
        {loading ? (
          <Skeleton className="h-10 w-full rounded-full" />
        ) : (
          <Segmented
            aria-label="Relay"
            // Disabled per option, so the row still shows which position the relay is in
            // when there is nothing to change.
            options={RELAY_OPTIONS.map((option) => ({
              ...option,
              disabled: !canControl || sending !== null || awaiting !== null,
            }))}
            value={open ? 'open' : 'closed'}
            onValueChange={(next) => void send(next === 'closed' ? 'close' : 'open')}
            fill
          />
        )}
      </div>
    </SettingsSection>
  );
}
