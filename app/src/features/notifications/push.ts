import Constants, { ExecutionEnvironment } from 'expo-constants';
import * as Device from 'expo-device';
import * as Notifications from 'expo-notifications';
import { Platform } from 'react-native';

import {
  ALERT_SOUNDS,
  DEFAULT_SOUND,
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
