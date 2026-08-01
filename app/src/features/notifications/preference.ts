import * as SecureStore from 'expo-secure-store';

const KEY = 'dynavolt.notifications';

/**
 * Whether the user wants this device notified about alerts.
 *
 * Deliberately separate from the OS permission, because the two answer different
 * questions: the permission says whether the app is allowed to notify, this says
 * whether it should. An app cannot revoke its own permission, so without somewhere to
 * record the intent, switching notifications off would do nothing at all.
 *
 * Kept in SecureStore because it is the only persistence this app carries. The value
 * is not a secret; it is just sharing a shelf with the token.
 */
export async function loadEnabled(): Promise<boolean> {
  try {
    const stored = await SecureStore.getItemAsync(KEY);
    // Defaults on. Being told about an overloading transformer is the point of the app,
    // so it has to be opted out of rather than into.
    return stored === null ? true : stored === 'true';
  } catch {
    return true;
  }
}

export async function saveEnabled(enabled: boolean): Promise<void> {
  try {
    await SecureStore.setItemAsync(KEY, String(enabled));
  } catch {
    // A preference that fails to persist is not worth interrupting anyone over; it
    // just falls back to the default on the next launch.
  }
}
