import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from 'react';
import { Platform, Vibration } from 'react-native';

import * as alertsApi from '@/features/alerts/api';
import { useAuth } from '@/features/auth/context';
import { loadEnabled, saveEnabled } from '@/features/notifications/preference';
import {
  ensurePermission,
  notifyLocally,
  registerDevice,
  unregisterDevice,
} from '@/features/notifications/push';
import * as readingsApi from '@/features/readings/api';

const POLL_MS = 5000;

type NotificationsValue = {
  /** Unacknowledged alerts. Stays lit until someone acknowledges them. */
  activeAlerts: number;
  /** Overload readings recorded since the Logs tab was last opened. */
  newOverloads: number;
  markLogsSeen: () => void;
  /** Whether alerts may notify this device. Badges and counts are unaffected. */
  notificationsEnabled: boolean;
  /**
   * Turns notifications on or off, returning what it actually ended up as.
   *
   * Asking for "on" can still come back false: the OS permission is the user's to
   * give, and once it has been refused the app cannot raise the prompt again. The
   * caller uses the mismatch to explain that, rather than leaving a switch that
   * silently springs back.
   */
  setNotificationsEnabled: (next: boolean) => Promise<boolean>;
};

const NotificationsContext = createContext<NotificationsValue>({
  activeAlerts: 0,
  newOverloads: 0,
  markLogsSeen: () => undefined,
  notificationsEnabled: true,
  setNotificationsEnabled: async () => true,
});

export function useNotifications() {
  return useContext(NotificationsContext);
}

export function NotificationsProvider({
  children,
  watchLogs,
}: {
  children: ReactNode;
  watchLogs: boolean;
}) {
  const { token } = useAuth();

  const [activeAlerts, setActiveAlerts] = useState(0);
  const [overloadTotal, setOverloadTotal] = useState<number | null>(null);
  const [seenOverloads, setSeenOverloads] = useState<number | null>(null);
  /** Null until the first poll, so opening the app never announces old alerts. */
  const lastCount = useRef<number | null>(null);

  const [enabled, setEnabled] = useState(true);
  // Read in a ref as well, because the polling effect below closes over it and should
  // not be torn down and restarted just because the switch moved.
  const enabledRef = useRef(true);

  useEffect(() => {
    let active = true;

    void loadEnabled().then((stored) => {
      if (!active) return;
      setEnabled(stored);
      enabledRef.current = stored;
    });

    return () => {
      active = false;
    };
  }, []);

  // Remote push covers a closed app, but only from a development build. This is what
  // makes an alert visible in Expo Go, and it costs nothing where push also works.
  useEffect(() => {
    if (!token || !enabled) return;

    void registerDevice(token);
  }, [token, enabled]);

  useEffect(() => {
    if (!token) return;

    let active = true;
    const controller = new AbortController();

    async function tick() {
      try {
        const count = await alertsApi.activeCount(token ?? '', controller.signal);
        if (!active) return;

        // Only a rise means something new opened. Acknowledging lowers the count and
        // must stay silent.
        // The badge and the count keep working when notifications are off. Only the
        // things that interrupt, the buzz and the banner, are held back.
        if (lastCount.current !== null && count > lastCount.current && enabledRef.current) {
          const raised = count - lastCount.current;
          if (Platform.OS !== 'web') Vibration.vibrate([0, 400, 200, 400, 200, 600]);
          void notifyLocally(
            raised === 1 ? 'Transformer alert' : `${raised} transformer alerts`,
            raised === 1
              ? 'A reading crossed a threshold. Open VITAL to acknowledge it.'
              : 'Readings crossed the thresholds. Open VITAL to acknowledge them.'
          );
        }
        lastCount.current = count;
        setActiveAlerts(count);

        if (!watchLogs) return;

        const overloads = await readingsApi.history(
          token ?? '',
          { status: 'overload', limit: 1 },
          controller.signal
        );
        if (active) setOverloadTotal(overloads.total);
      } catch {
        // A failed poll just leaves the badge as it was; the screens surface errors.
      }
    }

    void tick();
    const id = setInterval(() => void tick(), POLL_MS);

    return () => {
      active = false;
      controller.abort();
      clearInterval(id);
    };
  }, [token, watchLogs]);

  // The first successful poll establishes the baseline, so opening the app does
  // not light the badge for overloads that were already there.
  useEffect(() => {
    if (overloadTotal !== null && seenOverloads === null) setSeenOverloads(overloadTotal);
  }, [overloadTotal, seenOverloads]);

  const markLogsSeen = useCallback(() => {
    setSeenOverloads(overloadTotal ?? 0);
  }, [overloadTotal]);

  const setNotificationsEnabled = useCallback(
    async (next: boolean) => {
      if (next) {
        // Asking the OS first, because saying yes here is meaningless without it. If
        // the permission has already been refused this returns false without a prompt,
        // and the switch stays off rather than lying about what will happen.
        const permitted = await ensurePermission();
        if (!permitted) return false;

        setEnabled(true);
        enabledRef.current = true;
        await saveEnabled(true);
        if (token) void registerDevice(token);
        return true;
      }

      setEnabled(false);
      enabledRef.current = false;
      await saveEnabled(false);
      // Drops the push token server side too. Silencing the banner locally would still
      // leave this device on the list every alert fans out to.
      if (token) void unregisterDevice(token);
      return false;
    },
    [token]
  );

  const newOverloads =
    overloadTotal === null || seenOverloads === null ? 0 : Math.max(0, overloadTotal - seenOverloads);

  const value = useMemo(
    () => ({
      activeAlerts,
      newOverloads,
      markLogsSeen,
      notificationsEnabled: enabled,
      setNotificationsEnabled,
    }),
    [activeAlerts, newOverloads, markLogsSeen, enabled, setNotificationsEnabled]
  );

  return <NotificationsContext.Provider value={value}>{children}</NotificationsContext.Provider>;
}
