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
import { createAudioPlayer, setAudioModeAsync } from 'expo-audio';
import { Platform, Vibration } from 'react-native';

import * as alertsApi from '@/features/alerts/api';
import { useAuth } from '@/features/auth/context';
import {
  DEFAULT_SECONDS,
  loadAlertSeconds,
  saveAlertSeconds,
} from '@/features/notifications/alert-length';
import {
  clearCustomSound,
  loadCustomSound,
  pickCustomSound,
  type CustomSound,
} from '@/features/notifications/custom-sound';
import {
  DEFAULT_SOUND,
  loadAlertSound,
  saveAlertSound,
  soundFor,
  type AlertSoundName,
} from '@/features/notifications/alert-sound';
import {
  DEFAULT_PATTERN,
  loadAlertPattern,
  pulseFor,
  saveAlertPattern,
  type AlertPatternName,
} from '@/features/notifications/alert-pattern';
import { loadEnabled, saveEnabled } from '@/features/notifications/preference';
import {
  cancelTestNotifications,
  clearDelivered,
  ensurePermission,
  notifyLocally,
  onNotificationTapped,
  registerDevice,
  sendTestNotification,
  unregisterDevice,
} from '@/features/notifications/push';
import * as readingsApi from '@/features/readings/api';
import type { LiveReading } from '@/features/readings/types';

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
  /** How long the phone buzzes for an alert, in seconds. */
  alertSeconds: number;
  setAlertSeconds: (seconds: number) => void;
  /** Which buzz shape an alert uses. */
  alertPattern: AlertPatternName;
  setAlertPattern: (name: AlertPatternName) => void;
  /** Which bundled tone an alert plays. Works with the app closed. */
  alertSound: AlertSoundName;
  setAlertSound: (name: AlertSoundName) => void;
  /** The chosen sound file, or null when none has been picked. */
  customSound: CustomSound | null;
  /** Opens the file picker. Returns false only on a real failure, not a dismissal. */
  chooseCustomSound: () => Promise<boolean>;
  removeCustomSound: () => Promise<void>;
  /** True while the preview is buzzing, so the button can offer to stop it. */
  previewing: boolean;
  /** Plays the chosen pattern for the chosen length, or stops one already playing. */
  togglePreview: () => void;
  /**
   * Schedules a real notification a few seconds out, so the tone can be heard the way
   * a genuine alert arrives: drawn by Android, with the app closed.
   */
  sendTest: () => Promise<{ ok: boolean; detail: string }>;
  /** Cancels a running test. True when there was one to cancel. */
  cancelTest: () => Promise<boolean>;
  /**
   * Hands the newest live reading to the alarm.
   *
   * The alarm runs off this rather than off the backend's alert list, because the list
   * is a record and a record is always behind: the board posts, a row is written, an
   * alert is raised, and only then does a poll notice. Every one of those steps is
   * latency in front of a noise whose whole job is to be immediate. The screen already
   * holds the measurement and the threshold it is judged by, so it can decide itself.
   *
   * The backend still owns the alert: who acknowledged it, when, and how long they
   * took. That is a different question from whether to make a noise right now.
   */
  reportLive: (reading: LiveReading | null) => void;
  /**
   * Stops an alarm: the buzz, anything still queued, and what is already in the tray.
   *
   * Shared by the notification tap and the acknowledge button, which are the two ways
   * of saying the alert has been seen and should therefore both end it.
   */
  silence: () => void;
};

const NotificationsContext = createContext<NotificationsValue>({
  activeAlerts: 0,
  newOverloads: 0,
  markLogsSeen: () => undefined,
  notificationsEnabled: true,
  setNotificationsEnabled: async () => true,
  alertSeconds: DEFAULT_SECONDS,
  setAlertSeconds: () => undefined,
  alertPattern: DEFAULT_PATTERN,
  setAlertPattern: () => undefined,
  alertSound: DEFAULT_SOUND,
  setAlertSound: () => undefined,
  customSound: null,
  chooseCustomSound: async () => false,
  removeCustomSound: async () => undefined,
  previewing: false,
  togglePreview: () => undefined,
  sendTest: async () => ({ ok: false, detail: '' }),
  cancelTest: async () => false,
  reportLive: () => undefined,
  silence: () => undefined,
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

  /** Pending stop for the current buzz, so a new alert restarts rather than stacks. */
  const buzzStop = useRef<ReturnType<typeof setTimeout> | null>(null);

  /**
   * Bumped by every start and every stop, to identify which buzz a callback belongs to.
   *
   * The player is created asynchronously, so a stop can land in the gap between asking
   * for one and getting it. Without this the stop finds nothing to release, and the
   * player it was meant to kill is created a moment later and loops forever with no
   * reference left to stop it. Tapping quickly stacks up several of those at once.
   */
  const generation = useRef(0);

  /**
   * Buzzes for `seconds` by repeating the pulse and cancelling on a timer.
   *
   * Repeat-and-cancel rather than one long pattern: at five minutes the array would be
   * a thousand entries, and Android limits how long a pattern it will take.
   */
  const releasePlayer = useCallback(() => {
    const current = player.current;
    // Cleared first, so anything reaching for the player mid-teardown finds nothing
    // rather than a half-released one.
    player.current = null;
    if (!current) return;

    // Stopped before it is released, and in its own try. Releasing a player does not
    // reliably halt what it is already playing, and a looping one carries on with its
    // handle gone and nothing left to stop it. Clearing the loop first stops it
    // restarting in the gap between the pause and the release.
    try {
      current.loop = false;
      current.pause();
    } catch {
      // Already stopped, or gone. The release below is what actually matters.
    }

    try {
      current.remove();
    } catch {
      // Already released. Nothing to do, and nothing worth reporting.
    }
  }, []);

  const buzz = useCallback(
    (seconds: number, name: AlertPatternName) => {
      if (buzzStop.current) clearTimeout(buzzStop.current);
      releasePlayer();

      const current = ++generation.current;

      Vibration.vibrate(pulseFor(name), true);

      // An uploaded file wins over a bundled tone: someone who went to the trouble of
      // choosing their own meant it. Either way the app plays the sound itself here,
      // because a notification channel only makes noise when the app is not in front.
      //
      // It loops so a short clip fills the whole alert rather than playing once into
      // silence.
      const custom = customSoundRef.current;
      const bundled = soundFor(alertSoundRef.current).asset;
      const source = custom ? { uri: custom.uri } : bundled;

      if (source) {
        // Matched to the vibration, which is a system call and carries on when the app
        // goes to the background. Without this the sound stopped there and the buzz did
        // not, so an alert half survived being put down. Both now run the full length.
        //
        // This covers the app being backgrounded, not killed: with no process there is
        // no player, and the repeated notifications are what carry the alarm instead.
        void setAudioModeAsync({ playsInSilentMode: true, shouldPlayInBackground: true })
          .catch(() => undefined)
          .then(() => {
            const created = createAudioPlayer(source);

            // Stopped while this was being set up, so it is already unwanted. Released
            // rather than assigned: assigning would leave it playing under a state that
            // says nothing is.
            if (generation.current !== current) {
              created.remove();
              return;
            }

            created.loop = true;
            created.play();
            player.current = created;
          })
          .catch(() => {
            // A sound that will not play must not take the vibration down with it.
          });
      }

      buzzStop.current = setTimeout(() => {
        if (generation.current !== current) return;

        generation.current += 1;
        Vibration.cancel();
        releasePlayer();
        buzzStop.current = null;
        setPreviewing(false);
      }, seconds * 1000);
    },
    [releasePlayer]
  );

  const stopBuzz = useCallback(() => {
    if (buzzStop.current) clearTimeout(buzzStop.current);
    buzzStop.current = null;
    // Invalidates any player still being created, so it releases itself on arrival.
    generation.current += 1;
    Vibration.cancel();
    releasePlayer();
    setPreviewing(false);
  }, [releasePlayer]);

  /** What the running test still has queued, so it can be called off. */
  const testIds = useRef<string[]>([]);

  /**
   * Set by the stop button and by acknowledging, cleared when the alerts are gone or a
   * new one arrives. Without it the poll would restart the buzz seconds after someone
   * asked for quiet.
   */
  const silenced = useRef(false);

  /** Whether the last live reading was over a limit, so a return to normal is visible. */
  const liveOver = useRef(false);

  /**
   * The relay position last seen, so only a change is announced.
   *
   * Null until the first reading, which is what stops opening the app announcing a
   * relay that opened an hour ago. The same reason the alert count establishes a
   * baseline silently on its first poll.
   */
  const lastRelay = useRef<boolean | null>(null);

  /**
   * Says when the contacts move, which nothing else does.
   *
   * The alarm follows the load and stops when the load comes back down, so on its own
   * it never tells anyone the relay actually opened: the alarm falls silent either way,
   * whether the operator shed load or the board cut it. Those are very different
   * outcomes and only one of them leaves the transformer disconnected.
   *
   * A banner rather than a buzz. An opening is nearly always accompanied by the
   * overload alarm already sounding, and a second noise on top of it says nothing the
   * first one did not.
   */
  const announceRelay = useCallback((closed: boolean | null) => {
    if (closed === null) return;

    const previous = lastRelay.current;
    lastRelay.current = closed;

    if (previous === null || previous === closed || !enabledRef.current) return;

    void notifyLocally(
      closed ? 'Load reconnected' : 'Load disconnected',
      closed
        ? 'The relay closed. The transformer is supplying the load again.'
        : 'The relay opened. The load is disconnected until it closes again.',
      alertSoundRef.current
    );
  }, []);

  const reportLive = useCallback(
    (reading: LiveReading | null) => {
      if (!reading || Platform.OS === 'web') return;

      announceRelay(reading.relayClosed ?? null);

      const over = reading.status === 'overload' || reading.overTemperature;

      if (!over) {
        // The fault is gone, so the noise goes with it, and the silence is spent: the
        // next crossing is a new event and has to be able to sound.
        if (liveOver.current) stopBuzz();
        liveOver.current = false;

        return;
      }

      liveOver.current = true;

      // Re-armed once the previous round finishes rather than restarted every second,
      // which would retrigger the pattern from the top and never let it play.
      if (!enabledRef.current || buzzStop.current || silenced.current) return;

      buzz(alertSecondsRef.current, alertPatternRef.current);
    },
    [buzz, stopBuzz, announceRelay]
  );

  const silence = useCallback(() => {
    silenced.current = true;
    stopBuzz();
    void cancelTestNotifications(testIds.current);
    testIds.current = [];
    void clearDelivered();
  }, [stopBuzz]);

  // A repeating vibration outlives the component that started it, so it has to be
  // stopped explicitly rather than left to the timer that may never fire.
  useEffect(
    () => () => {
      if (buzzStop.current) clearTimeout(buzzStop.current);
      generation.current += 1;
      Vibration.cancel();
      releasePlayer();
    },
    [releasePlayer]
  );

  const [alertPattern, setAlertPatternState] = useState<AlertPatternName>(DEFAULT_PATTERN);
  const alertPatternRef = useRef<AlertPatternName>(DEFAULT_PATTERN);
  const [previewing, setPreviewing] = useState(false);
  const [customSound, setCustomSound] = useState<CustomSound | null>(null);
  const customSoundRef = useRef<CustomSound | null>(null);
  const [alertSound, setAlertSoundState] = useState<AlertSoundName>(DEFAULT_SOUND);
  const alertSoundRef = useRef<AlertSoundName>(DEFAULT_SOUND);
  /** The player for the current buzz, held so it can be stopped and released. */
  const player = useRef<ReturnType<typeof createAudioPlayer> | null>(null);

  const [alertSeconds, setAlertSecondsState] = useState(DEFAULT_SECONDS);
  // Read through a ref for the same reason as `enabled`: the polling effect closes over
  // it and should not be torn down every time the slider moves.
  const alertSecondsRef = useRef(DEFAULT_SECONDS);

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

    void loadAlertSeconds().then((stored) => {
      if (!active) return;
      setAlertSecondsState(stored);
      alertSecondsRef.current = stored;
    });

    void loadAlertPattern().then((stored) => {
      if (!active) return;
      setAlertPatternState(stored);
      alertPatternRef.current = stored;
    });

    void loadAlertSound().then((stored) => {
      if (!active) return;
      setAlertSoundState(stored);
      alertSoundRef.current = stored;
    });

    void loadCustomSound().then((stored) => {
      if (!active) return;
      setCustomSound(stored);
      customSoundRef.current = stored;
    });

    return () => {
      active = false;
    };
  }, []);

  /**
   * Tapping a notification stops the alarm.
   *
   * An alert that covers its full length keeps sounding on its own schedule, so without
   * this, seeing it and acting on it would change nothing: it would carry on until it
   * ran out. Everything queued is called off, the buzz stops, and the tray is cleared of
   * the passes that already arrived.
   *
   * It also acknowledges the alert, which is what stops the rest of the fleet being
   * notified about something already being dealt with, and records the response time.
   * Only when the notification carries an alert: a test has nothing to acknowledge.
   *
   * A failure here is ignored on purpose. Losing the race to another engineer is the
   * ordinary way to get one, and the alert is acknowledged either way.
   */
  useEffect(
    () =>
      onNotificationTapped((alertId) => {
        silence();

        if (alertId !== null && token) {
          void alertsApi
            .acknowledge(token, alertId)
            .then(() => setActiveAlerts((count) => Math.max(0, count - 1)))
            .catch(() => undefined);
        }
      }),
    [silence, token]
  );

  // Remote push covers a closed app, but only from a development build. This is what
  // makes an alert visible in Expo Go, and it costs nothing where push also works.
  useEffect(() => {
    if (!token || !enabled) return;

    // Re-registered whenever the tone changes, not just at sign-in: the server composes
    // the push and reads the channel off the stored token, so a tone chosen here is
    // silent when the app is closed until the server has been told about it.
    void registerDevice(token, alertSound);
  }, [token, enabled, alertSound]);

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
        // A newly opened alert, which is worth a banner wherever the app happens to be.
        // Keeping an ongoing one sounding is not this path's job: an alert stays open
        // until somebody acknowledges it, long after the load may have come back down,
        // and alarming for a fault that has passed is how people learn to ignore alarms.
        // The live reading drives that, because it knows whether it is still happening.
        const rose = lastCount.current !== null && count > lastCount.current;

        if (rose && enabledRef.current) {
          // A new alert is new information, so an earlier silence does not cover it.
          silenced.current = false;

          if (Platform.OS !== 'web') buzz(alertSecondsRef.current, alertPatternRef.current);

          const raised = count - (lastCount.current ?? 0);
          void notifyLocally(
            raised === 1 ? 'Transformer alert' : `${raised} transformer alerts`,
            raised === 1
              ? 'A reading crossed a threshold. Open Vital to acknowledge it.'
              : 'Readings crossed the thresholds. Open Vital to acknowledge them.',
            alertSoundRef.current
          );
        }

        // Nothing left open means nothing left to silence.
        if (count === 0) silenced.current = false;

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

  const setAlertSeconds = useCallback((seconds: number) => {
    setAlertSecondsState(seconds);
    alertSecondsRef.current = seconds;
    void saveAlertSeconds(seconds);
  }, []);

  const setAlertSound = useCallback((name: AlertSoundName) => {
    setAlertSoundState(name);
    alertSoundRef.current = name;
    void saveAlertSound(name);
  }, []);

  const setAlertPattern = useCallback((name: AlertPatternName) => {
    setAlertPatternState(name);
    alertPatternRef.current = name;
    void saveAlertPattern(name);
  }, []);

  /**
   * Plays exactly what a real alert would: same pattern, same length, same driver.
   *
   * Stoppable, because the length goes up to five minutes and nobody wants to wait
   * that out to hear what they picked.
   */
  const togglePreview = useCallback(() => {
    if (previewing) {
      stopBuzz();
      return;
    }
    if (Platform.OS === 'web') return;

    setPreviewing(true);
    buzz(alertSecondsRef.current, alertPatternRef.current);
  }, [previewing, stopBuzz, buzz]);

  const sendTest = useCallback(async () => {
    // A second test would otherwise layer on the first, and the earlier passes would
    // keep arriving with nothing tracking them.
    await cancelTestNotifications(testIds.current);

    const result = await sendTestNotification(alertSoundRef.current, alertSecondsRef.current);
    testIds.current = result.identifiers;

    return { ok: result.ok, detail: result.detail };
  }, []);

  const cancelTest = useCallback(async () => {
    if (testIds.current.length === 0) return false;

    await cancelTestNotifications(testIds.current);
    testIds.current = [];

    return true;
  }, []);

  const chooseCustomSound = useCallback(async () => {
    try {
      const picked = await pickCustomSound();
      // Null means the picker was dismissed, which is not a failure.
      if (!picked) return true;

      setCustomSound(picked);
      customSoundRef.current = picked;
      return true;
    } catch {
      return false;
    }
  }, []);

  const removeCustomSound = useCallback(async () => {
    setCustomSound(null);
    customSoundRef.current = null;
    await clearCustomSound();
  }, []);

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
        if (token) void registerDevice(token, alertSoundRef.current);
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
      alertSeconds,
      setAlertSeconds,
      alertPattern,
      setAlertPattern,
      alertSound,
      setAlertSound,
      customSound,
      chooseCustomSound,
      removeCustomSound,
      previewing,
      togglePreview,
      sendTest,
      cancelTest,
      silence,
      reportLive,
    }),
    [
      activeAlerts,
      newOverloads,
      markLogsSeen,
      enabled,
      setNotificationsEnabled,
      alertSeconds,
      setAlertSeconds,
      alertPattern,
      setAlertPattern,
      alertSound,
      setAlertSound,
      customSound,
      chooseCustomSound,
      removeCustomSound,
      previewing,
      togglePreview,
      sendTest,
      cancelTest,
      silence,
      reportLive,
    ]
  );

  return <NotificationsContext.Provider value={value}>{children}</NotificationsContext.Provider>;
}
