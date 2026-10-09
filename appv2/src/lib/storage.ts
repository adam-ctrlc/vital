import { Preferences } from '@capacitor/preferences';

/**
 * Small persistent key-value store, standing in for expo-secure-store.
 *
 * Capacitor Preferences is SharedPreferences on Android and localStorage on the web.
 * Neither is encrypted the way the Expo keychain was, so nothing stored here should be
 * worth more than the session token it already holds.
 */
export async function getItem(key: string): Promise<string | null> {
  const { value } = await Preferences.get({ key });
  return value;
}

export async function setItem(key: string, value: string): Promise<void> {
  await Preferences.set({ key, value });
}

export async function deleteItem(key: string): Promise<void> {
  await Preferences.remove({ key });
}
