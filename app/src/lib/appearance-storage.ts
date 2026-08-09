import * as SecureStore from 'expo-secure-store';

const KEY = 'dynavolt.appearance';
const THEME_KEY = 'dynavolt.theme';

/** The three chosen options, by label. Absent means never chosen. */
export type StoredLabels = {
  primary?: string;
  accent?: string;
  background?: string;
};

/**
 * Labels rather than colors, and resolved by the caller rather than here.
 *
 * Storing the hex would pin a phone to whatever the palette looked like the day it was
 * chosen: retuning a shade later would leave that device on the old one forever, with
 * nothing to say why. A label is looked up against the current palette every launch, so
 * an edit reaches everyone, and an option that is removed falls back to the default
 * instead of restoring a color that no longer exists.
 *
 * The lookup lives with the palette, so this file stays a plain string store and the
 * two do not have to import each other.
 */
export async function loadAppearanceLabels(): Promise<StoredLabels> {
  try {
    const stored = await SecureStore.getItemAsync(KEY);
    if (!stored) return {};

    const parsed = JSON.parse(stored) as StoredLabels;

    // A hand-edited or half-written value should read as "nothing chosen" rather than
    // reaching the caller as something it has to defend against.
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch {
    return {};
  }
}

export async function saveAppearanceLabels(labels: StoredLabels): Promise<void> {
  try {
    await SecureStore.setItemAsync(KEY, JSON.stringify(labels));
  } catch {
    // A palette that fails to persist is not worth interrupting anyone over; it just
    // falls back to the default on the next launch.
  }
}

/**
 * The chosen theme, or null when it has never been set.
 *
 * Null is meaningful and not the same as light: it means follow the phone, which is
 * what the app does until someone decides otherwise. Collapsing the two would quietly
 * pin every fresh install to light.
 */
export async function loadTheme(): Promise<'light' | 'dark' | null> {
  try {
    const stored = await SecureStore.getItemAsync(THEME_KEY);

    return stored === 'light' || stored === 'dark' ? stored : null;
  } catch {
    return null;
  }
}

export async function saveTheme(theme: 'light' | 'dark'): Promise<void> {
  try {
    await SecureStore.setItemAsync(THEME_KEY, theme);
  } catch {
    // As above: the default on next launch is the phone's own setting.
  }
}
