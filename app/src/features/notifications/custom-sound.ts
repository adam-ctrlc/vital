import * as DocumentPicker from 'expo-document-picker';
import { Directory, File, Paths } from 'expo-file-system';
import * as SecureStore from 'expo-secure-store';

const KEY = 'dynavolt.customSound';
const FOLDER = 'alert-sound';

export type CustomSound = {
  /** A file:// URI inside the app's own storage, safe to keep across launches. */
  uri: string;
  /** What the file was called when it was picked, so the UI can name it. */
  name: string;
};

/**
 * Copies the picked file into the app's own storage rather than keeping the picker's
 * URI. A document picker hands back a cache path or a content:// grant, and neither
 * survives a reboot or a cache sweep, so the sound would silently stop working.
 */
async function adopt(sourceUri: string, name: string): Promise<CustomSound> {
  const folder = new Directory(Paths.document, FOLDER);
  if (!folder.exists) folder.create({ intermediates: true });

  // One slot. Replacing the sound should not leave the old one behind forever.
  for (const existing of folder.list()) existing.delete();

  const extension = name.includes('.') ? name.slice(name.lastIndexOf('.')) : '.m4a';
  const destination = new File(folder, `sound${extension}`);
  new File(sourceUri).copy(destination);

  return { uri: destination.uri, name };
}

/**
 * Asks for an audio file and keeps it.
 *
 * Returns null when the picker was dismissed, which is not a failure and should not
 * be reported as one.
 */
export async function pickCustomSound(): Promise<CustomSound | null> {
  const result = await DocumentPicker.getDocumentAsync({
    type: 'audio/*',
    copyToCacheDirectory: true,
    multiple: false,
  });

  if (result.canceled || result.assets.length === 0) return null;

  const asset = result.assets[0];
  const adopted = await adopt(asset.uri, asset.name);
  await SecureStore.setItemAsync(KEY, JSON.stringify(adopted));

  return adopted;
}

export async function loadCustomSound(): Promise<CustomSound | null> {
  try {
    const stored = await SecureStore.getItemAsync(KEY);
    if (!stored) return null;

    const parsed = JSON.parse(stored) as CustomSound;
    // The record can outlive the file if storage was cleared, and a missing file would
    // fail at the worst moment, so it is checked rather than trusted.
    return new File(parsed.uri).exists ? parsed : null;
  } catch {
    return null;
  }
}

export async function clearCustomSound(): Promise<void> {
  try {
    await SecureStore.deleteItemAsync(KEY);
    const folder = new Directory(Paths.document, FOLDER);
    if (folder.exists) folder.delete();
  } catch {
    // Losing the file matters less than the preference, which is already gone.
  }
}
