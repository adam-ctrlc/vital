import { Capacitor, CapacitorHttp } from '@capacitor/core';
import { APP_VERSION } from './app-version';
import { compareVersions, MANIFEST_URL, parseManifest, planUpdate, type BundleRelease } from './manifest';
import { getUpdateState, setBundlePhase, setUpdateState } from './store';

const RECHECK_MS = 30 * 60 * 1000;
const RETRY_MS = 60 * 1000;
const ATTEMPT_KEY = 'vital.update-attempt';
const BROKEN_KEY = 'vital.update-broken';

let lastSuccess = 0;
let lastAttempt = 0;
let checking = false;
let installing = false;
let offered: BundleRelease | null = null;

function readKey(key: string): string | null {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}

function writeKey(key: string, value: string | null): void {
  try {
    if (value === null) localStorage.removeItem(key);
    else localStorage.setItem(key, value);
  } catch {
    // Storage blocked: the worst case is one more download attempt of a broken version.
  }
}

// installUpdate writes down which version it is switching to. If the next launch is running
// something else, that version never booted and the plugin rolled back, so it is marked
// broken and not downloaded again until a newer one is published.
function settleLastAttempt(): void {
  const attempted = readKey(ATTEMPT_KEY);
  if (!attempted) return;
  if (attempted !== APP_VERSION) writeKey(BROKEN_KEY, attempted);
  writeKey(ATTEMPT_KEY, null);
}

// Must run as soon as the bundle starts: if a live update fails to boot, the plugin never
// hears this and rolls the phone back to the last version that worked.
export async function markBundleHealthy(): Promise<void> {
  if (!Capacitor.isNativePlatform()) return;
  const { CapacitorUpdater } = await import('@capgo/capacitor-updater');
  await CapacitorUpdater.notifyAppReady();
}

async function readManifest(): Promise<unknown> {
  // CapacitorHttp runs natively, so GitHub's download redirect isn't blocked by CORS.
  const res = await CapacitorHttp.get({
    url: MANIFEST_URL,
    responseType: 'text',
    headers: { 'Cache-Control': 'no-cache' },
  });
  if (res.status !== 200) return null;
  return typeof res.data === 'string' ? JSON.parse(res.data) : res.data;
}

// Reuses a bundle already downloaded on an earlier launch. A download that merely broke off
// leaves an "error" entry, so those are cleared and fetched again. The plugin reports
// progress while it works.
async function fetchBundle(bundle: BundleRelease, onPercent: (percent: number) => void): Promise<string> {
  const { CapacitorUpdater } = await import('@capgo/capacitor-updater');
  const { bundles } = await CapacitorUpdater.list();
  const known = bundles.filter((b) => b.version === bundle.version);
  const ready = known.find((b) => b.status === 'pending' || b.status === 'success');
  if (ready) return ready.id;
  for (const failed of known.filter((b) => b.status === 'error')) {
    await CapacitorUpdater.delete({ id: failed.id }).catch(() => undefined);
  }
  const progress = await CapacitorUpdater.addListener('download', (event) => onPercent(event.percent));
  try {
    const downloaded = await CapacitorUpdater.download({
      url: MANIFEST_URL,
      version: bundle.version,
      manifest: bundle.files.map((f) => ({ file_name: f.name, file_hash: f.hash, download_url: f.url })),
    });
    return downloaded.id;
  } finally {
    void progress.remove();
  }
}

// Offline, a dropped connection, a GitHub hiccup or a bad manifest all end the same way:
// nothing changes, the app keeps running the version it has, and the next launch or resume
// tries again. A check only tells the user a version exists; nothing is downloaded until
// they press Update now. A version that failed to boot is never offered again (that would
// crash, roll back and ask forever) until a newer one is published.
async function checkNative(): Promise<void> {
  const now = Date.now();
  if (checking || installing || !navigator.onLine || now - lastAttempt < RETRY_MS) return;
  checking = true;
  lastAttempt = now;
  try {
    const { App } = await import('@capacitor/app');
    const info = await App.getInfo();
    const manifest = parseManifest(await readManifest());
    if (!manifest) return;
    const plan = planUpdate(manifest, APP_VERSION, Number(info.build));
    setUpdateState({
      apk: plan.apk ? { versionName: plan.apk.versionName, url: plan.apk.url, notes: manifest.notes } : null,
    });
    const bundle = plan.bundle && readKey(BROKEN_KEY) !== plan.bundle.version ? plan.bundle : null;
    offered = bundle;
    setUpdateState({
      bundle: bundle
        ? { version: bundle.version, notes: manifest.notes, phase: 'available', percent: 0 }
        : null,
    });
    lastSuccess = Date.now();
  } catch {
    // Left for the next launch or resume; see the note above.
  } finally {
    checking = false;
  }
}

// Website: each build ships version.json; a newer one means the page should reload.
async function checkWeb(): Promise<void> {
  if (import.meta.env.DEV) return;
  try {
    const res = await fetch(`/version.json?t=${Date.now()}`, { cache: 'no-store' });
    if (!res.ok) return;
    const { version } = (await res.json()) as { version?: string };
    if (version && compareVersions(version, APP_VERSION) > 0) setUpdateState({ web: { version } });
  } catch {
    // offline: try again on the next visit
  }
}

/** Dev only: open any page with ?previewUpdate to see the update screen in a browser. */
function previewUpdate(): boolean {
  if (!import.meta.env.DEV || !new URLSearchParams(window.location.search).has('previewUpdate')) return false;
  setUpdateState({
    bundle: {
      version: '9.9.9',
      phase: 'available',
      percent: 0,
      notes:
        'Clearer logs and live waveform\n\n- Filter logs by date, load and temperature\n- The waveform follows the load\n- Pick any primary colour',
    },
  });
  return true;
}

export function startUpdateChecks(): void {
  if (previewUpdate()) return;
  if (!Capacitor.isNativePlatform()) {
    void checkWeb();
    document.addEventListener(
      'visibilitychange',
      () => document.visibilityState === 'visible' && void checkWeb(),
    );
    return;
  }
  settleLastAttempt();
  void checkNative();
  void import('@capacitor/app').then(({ App }) =>
    App.addListener('resume', () => {
      if (Date.now() - lastSuccess > RECHECK_MS) void checkNative();
    }),
  );
}

// Update now: download with progress, then switch to the new version, which reloads the app.
// Pressing twice does nothing while one is under way; a failed download leaves Try again.
export async function installUpdate(): Promise<void> {
  const bundle = offered;
  const shown = getUpdateState().bundle;
  if (installing || !bundle || !shown || shown.version !== bundle.version) return;
  installing = true;
  setBundlePhase('downloading', 0);
  try {
    const id = await fetchBundle(bundle, (percent) => setBundlePhase('downloading', Math.min(99, percent)));
    setBundlePhase('installing', 100);
    const { CapacitorUpdater } = await import('@capgo/capacitor-updater');
    writeKey(ATTEMPT_KEY, bundle.version);
    await CapacitorUpdater.set({ id });
  } catch {
    setBundlePhase('failed', 0);
  } finally {
    installing = false;
  }
}

// Capacitor opens links to other sites in the phone's browser, which downloads the APK and
// hands it to Android's installer. The app itself never needs permission to install apps.
export function openApkDownload(url: string): void {
  window.location.href = url;
}
