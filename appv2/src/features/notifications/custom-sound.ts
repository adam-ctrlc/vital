const DB_NAME = 'vital';
const STORE = 'files';
const KEY = 'customSound';

/** Large enough for any reasonable alarm clip, small enough not to fill the device. */
const MAX_BYTES = 15 * 1024 * 1024;

export type CustomSound = {
  /** A blob: URL for the stored file, valid for as long as the page is open. */
  uri: string;
  /** What the file was called when it was picked, so the UI can name it. */
  name: string;
};

type StoredSound = { name: string; blob: Blob };

/**
 * Opens the one IndexedDB store this app uses.
 *
 * IndexedDB rather than the preferences store, because a sound file is megabytes and
 * Preferences is SharedPreferences on Android, which loads whole into memory. The
 * WebView keeps IndexedDB across launches, so the file survives a restart the way the
 * copy into the app's documents folder did in the native app.
 */
function openDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, 1);
    request.onupgradeneeded = () => request.result.createObjectStore(STORE);
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

async function withStore<T>(
  mode: IDBTransactionMode,
  run: (store: IDBObjectStore) => IDBRequest<T>
): Promise<T> {
  const db = await openDb();

  try {
    return await new Promise<T>((resolve, reject) => {
      const request = run(db.transaction(STORE, mode).objectStore(STORE));
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
  } finally {
    db.close();
  }
}

/** One object URL at a time, so replacing the sound does not leak the old file. */
let currentUrl: string | null = null;

function adopt(stored: StoredSound): CustomSound {
  if (currentUrl) URL.revokeObjectURL(currentUrl);
  currentUrl = URL.createObjectURL(stored.blob);

  return { uri: currentUrl, name: stored.name };
}

/**
 * Opens the file chooser and resolves with the file, or null when it was dismissed.
 *
 * Nothing is awaited before the click, on purpose: a browser only opens a chooser from
 * inside the tap that asked for it.
 */
function chooseFile(): Promise<File | null> {
  return new Promise((resolve) => {
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = 'audio/*';
    input.addEventListener('change', () => resolve(input.files?.[0] ?? null), { once: true });
    input.addEventListener('cancel', () => resolve(null), { once: true });
    input.click();
  });
}

/**
 * Asks for an audio file and keeps it.
 *
 * Returns null when the chooser was dismissed, which is not a failure and should not be
 * reported as one. Throws on a file that cannot be kept, which is.
 */
export async function pickCustomSound(): Promise<CustomSound | null> {
  const file = await chooseFile();
  if (!file) return null;

  if (!file.type.startsWith('audio/') || file.size > MAX_BYTES) {
    throw new Error('Not a usable audio file.');
  }

  const stored: StoredSound = { name: file.name, blob: file };
  await withStore('readwrite', (store) => store.put(stored, KEY));

  return adopt(stored);
}

export async function loadCustomSound(): Promise<CustomSound | null> {
  try {
    const stored = await withStore<StoredSound | undefined>('readonly', (store) => store.get(KEY));
    // The record is checked rather than trusted: storage can be cleared or half-written,
    // and a missing file would fail at the worst moment.
    return stored && stored.blob instanceof Blob ? adopt(stored) : null;
  } catch {
    return null;
  }
}

export async function clearCustomSound(): Promise<void> {
  if (currentUrl) URL.revokeObjectURL(currentUrl);
  currentUrl = null;

  try {
    await withStore('readwrite', (store) => store.delete(KEY));
  } catch {
    // Losing the file matters less than the preference, which is already gone.
  }
}
