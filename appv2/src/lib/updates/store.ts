/** `available` waits for Update now; `downloading` and `installing` follow it; `failed` offers Try again. */
export type BundlePhase = 'available' | 'downloading' | 'installing' | 'failed';

export type BundleUpdate = { version: string; notes: string; phase: BundlePhase; percent: number };

export type UpdateState = {
  /** A live update of the app's web code: downloads inside the app, no reinstall. */
  bundle: BundleUpdate | null;
  /** A new APK, needed only for native changes; it opens in the phone's browser. */
  apk: { versionName: string; url: string; notes: string } | null;
};

let state: UpdateState = { bundle: null, apk: null };
const listeners = new Set<() => void>();

export function getUpdateState(): UpdateState {
  return state;
}

/** Whether an update is waiting, which is when the update screen replaces the app. */
export function isUpdateRequired(current: UpdateState = state): boolean {
  return current.bundle !== null || current.apk !== null;
}

export function subscribeUpdates(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function setUpdateState(patch: Partial<UpdateState>): void {
  state = { ...state, ...patch };
  for (const listener of listeners) listener();
}

export function setBundlePhase(phase: BundlePhase, percent: number): void {
  if (state.bundle) setUpdateState({ bundle: { ...state.bundle, phase, percent } });
}
