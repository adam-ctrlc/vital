import { LocalNotifications } from '@capacitor/local-notifications';
import { PushNotifications } from '@capacitor/push-notifications';

import {
  ALERT_SOUNDS,
  DEFAULT_SOUND,
  TONE_SECONDS,
  soundFor,
  type AlertSoundName,
} from '@/features/notifications/alert-sound';
import { playSound } from '@/features/notifications/player';
import { request } from '@/lib/api-client';
import { IS_NATIVE, PLATFORM } from '@/lib/platform';

/**
 * Remote push is off for now, and has to be.
 *
 * The API sends through Expo's push service (api/src/notifications/service.rs posts to
 * exp.host), which only accepts Expo push tokens, and only an Expo build can mint one.
 * This app registers with Firebase directly, so its tokens are FCM tokens that service
 * would reject. Turning this on needs two things outside this file: a Firebase project
 * whose google-services.json sits in android/app, and the API sending to FCM for these
 * tokens instead of to Expo.
 *
 * Until then, alerts reach this device from the poll in the notifications context, which
 * runs while the app is open, including in the background for as long as Android lets
 * the WebView keep running.
 */
export function canReceiveRemotePush(): boolean {
  return false;
}

/** The browser's Notification API, when there is one. iOS Safari outside a home screen app has none. */
function webNotifications(): typeof Notification | null {
  return typeof window !== 'undefined' && 'Notification' in window ? window.Notification : null;
}

/**
 * Created once per launch rather than on every call. The native app re-created all of
 * them each time; that is harmless on Android, but there is no reason to repeat it.
 */
let channelsReady: Promise<void> | null = null;

function ensureChannels(): Promise<void> {
  // Android needs a channel before anything will surface, and importance 5 (max) is
  // what lets an overload interrupt rather than sit silently in the tray.
  channelsReady ??= (async () => {
    // One channel per tone, because Android copies a channel's sound in at creation and
    // will not let it be changed afterwards. Registering all of them up front means
    // switching tones is just a matter of posting through a different channel.
    //
    // They are created together rather than on demand so that the phone's own
    // notification settings list every tone the app can use, which is where someone
    // would go to override the choice made in here.
    for (const sound of ALERT_SOUNDS) {
      await LocalNotifications.createChannel({
        id: sound.channelId,
        name:
          sound.value === 'default' ? 'Transformer alerts' : `Transformer alerts (${sound.label})`,
        importance: 5,
        vibration: true,
        lights: true,
        lightColor: '#ef4444',
        // Resolved against res/raw by the plugin, which also sets the notification
        // audio attributes a sound needs to be heard. scripts/copy-android-sounds.mjs
        // is what puts the files there.
        ...(sound.file ? { sound: sound.file } : {}),
      });
    }

    try {
      await LocalNotifications.deleteChannel({ id: 'alerts' });
    } catch {
      // The old channel may already be gone on a fresh install; nothing to clean up.
    }
  })().catch((caught) => {
    // Let the next call try again rather than caching a failure for the whole session.
    channelsReady = null;
    throw caught;
  });

  return channelsReady;
}

/**
 * Asks for permission when it has not been decided, and reports whether it is granted.
 *
 * In a browser without notifications at all this answers yes: there is nothing to
 * refuse, and saying no would switch off the in-page alarm along with the banner that
 * was never possible.
 */
export async function ensurePermission(): Promise<boolean> {
  if (IS_NATIVE) {
    if (PLATFORM === 'android') await ensureChannels();

    const existing = await LocalNotifications.checkPermissions();
    if (existing.display === 'granted') return true;

    const asked = await LocalNotifications.requestPermissions();
    return asked.display === 'granted';
  }

  const api = webNotifications();
  if (!api) return true;
  if (api.permission === 'granted') return true;
  if (api.permission === 'denied') return false;

  return (await api.requestPermission()) === 'granted';
}

/** Waits for the token a push registration produces. */
async function pushToken(): Promise<string> {
  const token = new Promise<string>((resolve, reject) => {
    void PushNotifications.addListener('registration', ({ value }) => resolve(value));
    void PushNotifications.addListener('registrationError', ({ error }) => reject(new Error(error)));
  });

  await PushNotifications.register();
  return token;
}

/**
 * Registers this device for remote push.
 *
 * Returns false, rather than throwing, whenever remote push is unavailable, which for
 * now is always (see canReceiveRemotePush). Local notifications still work, so a failure
 * here must not take them down with it.
 */
export async function registerDevice(
  token: string,
  sound: AlertSoundName = DEFAULT_SOUND
): Promise<boolean> {
  if (!canReceiveRemotePush()) return false;

  try {
    if (!(await ensurePermission())) return false;

    const permission = await PushNotifications.requestPermissions();
    if (permission.receive !== 'granted') return false;

    await request<void>('/notifications/register', {
      method: 'POST',
      token,
      // The chosen channel travels with the token, because a remote push is composed on
      // the server and Android reads the sound off the channel it is delivered on. A
      // push that names no channel lands on the default one, which is why a tone played
      // in the app and went silent the moment it was closed.
      body: {
        token: await pushToken(),
        platform: PLATFORM,
        channelId: PLATFORM === 'android' ? soundFor(sound).channelId : undefined,
      },
    });

    return true;
  } catch {
    // Nothing here is worth interrupting sign-in for.
    return false;
  }
}

export async function unregisterDevice(token: string): Promise<void> {
  if (!canReceiveRemotePush()) return;

  try {
    await request<void>('/notifications/unregister', {
      method: 'POST',
      token,
      body: { token: await pushToken() },
    });
    await PushNotifications.unregister();
  } catch {
    // Signing out locally matters more than tidying the server's token list.
  }
}

/**
 * Notification ids are Java ints on Android, so they are counted up from a per-launch
 * base rather than taken from the clock in milliseconds.
 */
let nextId = (Math.floor(Date.now() / 1000) % 1_000_000) * 1000;

function newId(): number {
  nextId = (nextId + 1) % 2_147_483_647;
  return nextId;
}

/** Timers standing in for scheduled notifications in a browser, by id, so they can be cancelled. */
const webScheduled = new Map<string, ReturnType<typeof setTimeout>>();

/** Shows a browser notification, if allowed. Optionally plays a tone with it in the page. */
function showWebNotification(title: string, body: string, tone: string | null) {
  const api = webNotifications();

  try {
    if (api?.permission === 'granted') new api(title, { body, icon: '/images/favicon.png' });
  } catch {
    // Some browsers only allow notifications from a service worker. The tone still plays.
  }

  if (tone) playSound(tone);
}

/**
 * Fires a real notification after a short delay, so the closed app case can be heard.
 *
 * The preview button cannot show this. It plays the file in the page, which stops the
 * moment the app goes away, whereas a real alert is drawn by Android from the channel
 * and is unaffected by the app being gone. Those are different paths, and only this one
 * proves the tone survives leaving the app.
 *
 * The delay exists to be left: schedule it, close the app, and listen. In a browser
 * there is no such path, so the test plays the tone in the page alongside a browser
 * notification, and only while the tab stays open.
 */
export async function sendTestNotification(
  sound: AlertSoundName = DEFAULT_SOUND,
  alertSeconds = TONE_SECONDS,
  seconds = 5
): Promise<{ ok: boolean; detail: string; identifiers: string[] }> {
  try {
    if (!(await ensurePermission())) {
      return { ok: false, detail: 'Notifications are not permitted.', identifiers: [] };
    }

    const chosen = soundFor(sound);

    // Each tone runs for TONE_SECONDS and Android plays it exactly once, so covering the
    // chosen length means posting again as one finishes, for as many passes as it takes.
    // Uncapped by choice: the length is the setting, and a cap would quietly ignore it.
    //
    // The spacing is the same whichever tone is picked, including the device default,
    // whose length is unknowable from here.
    const passes = Math.max(1, Math.ceil(alertSeconds / TONE_SECONDS));
    const identifiers: string[] = [];

    const bodyFor = (pass: number) =>
      passes === 1
        ? `This is how ${chosen.label} sounds when Vital is closed.`
        : `This is how ${chosen.label} sounds when Vital is closed. ${pass + 1} of ${passes}.`;

    if (!IS_NATIVE) {
      for (let pass = 0; pass < passes; pass += 1) {
        const id = String(newId());
        webScheduled.set(
          id,
          setTimeout(
            () => {
              webScheduled.delete(id);
              showWebNotification('Vital test alert', bodyFor(pass), chosen.asset);
            },
            (seconds + pass * TONE_SECONDS) * 1000
          )
        );
        identifiers.push(id);
      }

      return {
        ok: true,
        detail: `${chosen.label} in ${seconds}s. Keep this tab open: a browser cannot play it once the page is closed.`,
        identifiers,
      };
    }

    const now = Date.now();
    const notifications = Array.from({ length: passes }, (_, pass) => ({
      id: newId(),
      title: 'Vital test alert',
      body: bodyFor(pass),
      // A channel id is the only way to pick the tone on Android, since the sound comes
      // from the channel rather than the notification.
      channelId: chosen.channelId,
      sound: chosen.file ?? undefined,
      schedule: { at: new Date(now + (seconds + pass * TONE_SECONDS) * 1000), allowWhileIdle: true },
    }));

    await LocalNotifications.schedule({ notifications });
    identifiers.push(...notifications.map((notification) => String(notification.id)));

    // Read back what Android actually holds, rather than what was asked for. A channel
    // keeps the settings it was created with for good, so one created before its sound
    // existed stays silent no matter how often it is set again, and nothing in the app
    // would otherwise show that.
    if (PLATFORM === 'android') {
      const { channels } = await LocalNotifications.listChannels();
      const channel = channels.find((candidate) => candidate.id === chosen.channelId);

      if (!channel) {
        return {
          ok: true,
          detail: `Sent, but channel ${chosen.channelId} does not exist.`,
          identifiers,
        };
      }

      // The plugin reports the channel's sound as a URI. A res/raw one means the bundled
      // file took; anything else is the system tone, right only for Device default. No
      // sound at all is a silent channel, which is the fault worth naming.
      const actual = channel.sound ? (channel.sound.includes('/raw/') ? 'custom' : 'default') : null;
      const expected = chosen.file ? 'custom' : 'default';
      const state =
        actual === null ? 'silent' : actual === expected ? 'correct' : `${actual}, expected ${expected}`;

      return {
        ok: true,
        detail:
          `${chosen.label}: channel sound ${state}, importance ${channel.importance}. ` +
          `${passes} ${passes === 1 ? 'pass' : 'passes'} covering ${passes * TONE_SECONDS}s.`,
        identifiers,
      };
    }

    return { ok: true, detail: `Sent. ${chosen.label} in ${seconds}s.`, identifiers };
  } catch (caught) {
    return { ok: false, detail: (caught as Error).message, identifiers: [] };
  }
}

/**
 * Runs when a notification is tapped, and returns its unsubscribe.
 *
 * Tapping is how someone says they have seen it, so it is the natural place to stop an
 * alarm that would otherwise keep going. Inside the app only: a browser notification
 * opens nothing worth listening for.
 */
export function onNotificationTapped(handler: (alertId: number | null) => void): () => void {
  if (!IS_NATIVE) return () => undefined;

  const subscription = LocalNotifications.addListener('localNotificationActionPerformed', (action) => {
    // Present on a real alert, absent on a test, so the caller can tell the two apart
    // rather than trying to acknowledge something that was never raised.
    const raw = (action.notification.extra as { alertId?: unknown } | undefined)?.alertId;
    const alertId = typeof raw === 'number' && Number.isFinite(raw) ? raw : null;

    handler(alertId);
  });

  return () => {
    void subscription.then((handle) => handle.remove());
  };
}

/**
 * Clears what is already in the tray.
 *
 * An alert covering its full length leaves one entry per pass, and dismissing them by
 * hand after acting on the first is a chore nobody should be given.
 */
export async function clearDelivered(): Promise<void> {
  if (!IS_NATIVE) return;

  try {
    await LocalNotifications.removeAllDeliveredNotifications();
  } catch {
    // A tray that will not clear is not worth surfacing an error over.
  }
}

/**
 * Cancels whatever a test still has queued.
 *
 * Necessary rather than tidy: covering ten minutes schedules fifty notifications, and
 * without this the only way to stop them would be to sit through them.
 */
export async function cancelTestNotifications(identifiers: string[]): Promise<void> {
  if (identifiers.length === 0) return;

  if (!IS_NATIVE) {
    for (const id of identifiers) {
      const timer = webScheduled.get(id);
      if (timer) clearTimeout(timer);
      webScheduled.delete(id);
    }
    return;
  }

  await LocalNotifications.cancel({
    notifications: identifiers.map((id) => ({ id: Number(id) })),
  }).catch(() => undefined);
}

/**
 * Raises a notification from the device itself.
 *
 * With remote push off, this is how an alert reaches the tray at all. It only fires
 * while the app is running, so it complements remote push rather than replacing it.
 *
 * In a browser it never asks for permission: this runs from a poll, and a prompt that
 * appears out of nowhere is one people learn to refuse. The switch in Profile asks.
 */
export async function notifyLocally(
  title: string,
  body: string,
  sound: AlertSoundName = 'default'
): Promise<void> {
  try {
    if (!IS_NATIVE) {
      showWebNotification(title, body, null);
      return;
    }

    if (!(await ensurePermission())) return;

    const chosen = soundFor(sound);

    await LocalNotifications.schedule({
      notifications: [
        {
          id: newId(),
          title,
          body,
          // A channel id is the only way to pick the tone on Android, since the sound
          // comes from the channel rather than the notification. No schedule fires it
          // immediately.
          channelId: chosen.channelId,
          sound: chosen.file ?? undefined,
        },
      ],
    });
  } catch {
    // A missing banner is not worth surfacing an error over.
  }
}
