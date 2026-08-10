import Constants, { ExecutionEnvironment } from 'expo-constants';
import * as Device from 'expo-device';
import * as Notifications from 'expo-notifications';
import { Platform } from 'react-native';

import {
  ALERT_SOUNDS,
  DEFAULT_SOUND,
  TONE_SECONDS,
  soundFor,
  type AlertSoundName,
} from '@/features/notifications/alert-sound';
import { request } from '@/lib/api-client';

/** Expo Go dropped remote push in SDK 53+; a development build is required. */
const IS_EXPO_GO = Constants.executionEnvironment === ExecutionEnvironment.StoreClient;

/** Alerts are the point of the app, so show them even while it is open. */
Notifications.setNotificationHandler({
  handleNotification: async () => ({
    shouldShowBanner: true,
    shouldShowList: true,
    shouldPlaySound: true,
    shouldSetBadge: false,
  }),
});

export function canReceiveRemotePush(): boolean {
  return !IS_EXPO_GO && Device.isDevice && Boolean(projectId());
}

function projectId(): string | undefined {
  return (
    Constants.expoConfig?.extra?.eas?.projectId ?? Constants.easConfig?.projectId ?? undefined
  );
}

export async function ensurePermission(): Promise<boolean> {
  // Android needs a channel before anything will surface, and `max` is what lets an
  // overload interrupt rather than sit silently in the tray.
  if (Platform.OS === 'android') {
    // One channel per tone, because Android copies a channel's sound in at creation and
    // will not let it be changed afterwards. Registering all of them up front means
    // switching tones is just a matter of posting through a different channel.
    //
    // They are created together rather than on demand so that the phone's own
    // notification settings list every tone the app can use, which is where someone
    // would go to override the choice made in here.
    for (const sound of ALERT_SOUNDS) {
      await Notifications.setNotificationChannelAsync(sound.channelId, {
        name:
          sound.value === 'default'
            ? 'Transformer alerts'
            : `Transformer alerts (${sound.label})`,
        importance: Notifications.AndroidImportance.MAX,
        vibrationPattern: [0, 400, 200, 400, 200, 600],
        lightColor: '#ef4444',
        ...(sound.file ? { sound: sound.file } : {}),
        // Required, not optional. Passing a sound without these leaves the channel
        // with null audio attributes, so Android has a file to play but nothing
        // saying which stream to play it on, and the notification arrives silent.
        audioAttributes: {
          usage: Notifications.AndroidAudioUsage.NOTIFICATION,
          contentType: Notifications.AndroidAudioContentType.SONIFICATION,
        },
      });
    }

    try {
      await Notifications.deleteNotificationChannelAsync('alerts');
    } catch {
      // The old channel may already be gone on a fresh install; nothing to clean up.
    }

  }

  const existing = await Notifications.getPermissionsAsync();
  if (existing.granted) return true;

  const asked = await Notifications.requestPermissionsAsync();
  return asked.granted;
}

/**
 * Registers this device for remote push.
 *
 * Returns false, rather than throwing, whenever remote push is unavailable: in Expo
 * Go, on a simulator, or without an EAS project. Local notifications still work in
 * all of those, so a failure here must not take them down with it.
 */
export async function registerDevice(
  token: string,
  sound: AlertSoundName = DEFAULT_SOUND
): Promise<boolean> {
  if (!canReceiveRemotePush()) return false;

  try {
    if (!(await ensurePermission())) return false;

    const pushToken = await Notifications.getExpoPushTokenAsync({ projectId: projectId() });
    await request<void>('/notifications/register', {
      method: 'POST',
      token,
      // The chosen channel travels with the token, because a remote push is composed on
      // the server and Android reads the sound off the channel it is delivered on. A
      // push that names no channel lands on the default one, which is why a tone played
      // in the app and went silent the moment it was closed.
      body: {
        token: pushToken.data,
        platform: Platform.OS,
        channelId: Platform.OS === 'android' ? soundFor(sound).channelId : undefined,
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
    const pushToken = await Notifications.getExpoPushTokenAsync({ projectId: projectId() });
    await request<void>('/notifications/unregister', {
      method: 'POST',
      token,
      body: { token: pushToken.data },
    });
  } catch {
    // Signing out locally matters more than tidying the server's token list.
  }
}

/**
 * Fires a real notification after a short delay, so the closed app case can be heard.
 *
 * The preview button cannot show this. It plays the file in process, which stops the
 * moment the app goes to the background, whereas a real alert is drawn by Android from
 * the channel and is unaffected by the app being gone. Those are different paths, and
 * only this one proves the tone survives leaving the app.
 *
 * The delay exists to be left: schedule it, close the app, and listen.
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

    for (let pass = 0; pass < passes; pass += 1) {
      const id = await Notifications.scheduleNotificationAsync({
        content: {
          title: 'Vital test alert',
          body:
            passes === 1
              ? `This is how ${chosen.label} sounds when Vital is closed.`
              : `This is how ${chosen.label} sounds when Vital is closed. ${pass + 1} of ${passes}.`,
          sound: chosen.file ?? 'default',
        },
        trigger: {
          type: Notifications.SchedulableTriggerInputTypes.TIME_INTERVAL,
          seconds: seconds + pass * TONE_SECONDS,
          repeats: false,
          ...(Platform.OS === 'android' ? { channelId: chosen.channelId } : {}),
        },
      });

      identifiers.push(id);
    }

    // Read back what Android actually holds, rather than what was asked for. A channel
    // keeps the settings it was created with for good, so one created before its sound
    // existed stays silent no matter how often it is set again, and nothing in the app
    // would otherwise show that.
    if (Platform.OS === 'android') {
      const channel = await Notifications.getNotificationChannelAsync(chosen.channelId);

      if (!channel) {
        return {
          ok: true,
          detail: `Sent, but channel ${chosen.channelId} does not exist.`,
          identifiers,
        };
      }

      // 'custom' means the bundled file took. 'default' is the system tone, right only
      // for Device default. null is a silent channel, which is the fault worth naming.
      const expected = chosen.file ? 'custom' : 'default';
      const state =
        channel.sound === null
          ? 'silent'
          : channel.sound === expected
            ? 'correct'
            : `${channel.sound}, expected ${expected}`;

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
 * alarm that would otherwise keep going.
 */
export function onNotificationTapped(handler: (alertId: number | null) => void): () => void {
  const subscription = Notifications.addNotificationResponseReceivedListener((response) => {
    // Present on a real alert, absent on a test, so the caller can tell the two apart
    // rather than trying to acknowledge something that was never raised.
    const raw = response.notification.request.content.data?.alertId;
    const alertId = typeof raw === 'number' && Number.isFinite(raw) ? raw : null;

    handler(alertId);
  });

  return () => subscription.remove();
}

/**
 * Clears what is already in the tray.
 *
 * An alert covering its full length leaves one entry per pass, and dismissing them by
 * hand after acting on the first is a chore nobody should be given.
 */
export async function clearDelivered(): Promise<void> {
  try {
    await Notifications.dismissAllNotificationsAsync();
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
  await Promise.all(
    identifiers.map((id) =>
      Notifications.cancelScheduledNotificationAsync(id).catch(() => undefined)
    )
  );
}

/**
 * Raises a notification from the device itself.
 *
 * This is what makes alerts visible in Expo Go, where remote push cannot reach us.
 * It only fires while the app is running, so it complements remote push rather than
 * replacing it.
 */
export async function notifyLocally(
  title: string,
  body: string,
  sound: AlertSoundName = 'default'
): Promise<void> {
  try {
    if (!(await ensurePermission())) return;

    const chosen = soundFor(sound);

    await Notifications.scheduleNotificationAsync({
      content: { title, body, sound: chosen.file ?? 'default' },
      // A channel id is the only way to pick the tone on Android, since the sound comes
      // from the channel rather than the notification. Passing it as the trigger fires
      // immediately, the same as a null trigger would.
      trigger: Platform.OS === 'android' ? { channelId: chosen.channelId } : null,
    });
  } catch {
    // A missing banner is not worth surfacing an error over.
  }
}
