export type BundleFile = { name: string; hash: string; url: string };

export type BundleRelease = { version: string; files: BundleFile[] };

export type ApkRelease = { versionCode: number; versionName: string; url: string };

/**
 * latest.json, published with every release. `version` is the web bundle (the app itself),
 * listed file by file so a phone only downloads files whose hash it does not already have.
 * `minNative` is the oldest installed APK build that can run that bundle; `apk` is the
 * newest APK.
 */
export type UpdateManifest = {
  version: string;
  notes: string;
  minNative: number;
  bundle: BundleRelease;
  apk: ApkRelease;
};

export const RELEASES_REPO = 'https://github.com/adam-ctrlc/vital-releases';
export const MANIFEST_URL = `${RELEASES_REPO}/releases/latest/download/latest.json`;

const VERSION = /^\d+\.\d+\.\d+$/;
const SHA256 = /^[0-9a-f]{64}$/;
const MAX_FILES = 2000;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Downloads come only from Vital's own releases, so a tampered manifest cannot point elsewhere. */
function ownReleaseUrl(value: unknown): value is string {
  return typeof value === 'string' && value.startsWith(`${RELEASES_REPO}/releases/download/`);
}

function positiveInt(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value > 0;
}

function safePath(value: unknown): value is string {
  if (typeof value !== 'string' || value.length === 0 || value.length > 200) return false;
  if (value.startsWith('/') || value.includes('\\')) return false;
  return value.split('/').every((part) => part !== '' && part !== '.' && part !== '..');
}

function parseFiles(raw: unknown): BundleFile[] | null {
  if (!Array.isArray(raw) || raw.length === 0 || raw.length > MAX_FILES) return null;
  const files: BundleFile[] = [];
  const seen = new Set<string>();
  for (const entry of raw) {
    if (!isRecord(entry)) return null;
    const { name, hash, url } = entry;
    if (!safePath(name) || typeof hash !== 'string' || !SHA256.test(hash) || !ownReleaseUrl(url) || seen.has(name)) {
      return null;
    }
    seen.add(name);
    files.push({ name, hash, url });
  }
  return files.some((file) => file.name === 'index.html') ? files : null;
}

/**
 * Everything the network hands back is checked field by field: a half-uploaded or
 * hand-edited manifest must never make the app download garbage.
 */
export function parseManifest(raw: unknown): UpdateManifest | null {
  if (!isRecord(raw) || !isRecord(raw['bundle']) || !isRecord(raw['apk'])) return null;
  const { version, notes, minNative } = raw;
  const bundle = raw['bundle'];
  const apk = raw['apk'];
  if (typeof version !== 'string' || !VERSION.test(version) || bundle['version'] !== version) return null;
  if (!positiveInt(minNative)) return null;
  const files = parseFiles(bundle['files']);
  if (!files) return null;
  if (!positiveInt(apk['versionCode']) || typeof apk['versionName'] !== 'string' || !ownReleaseUrl(apk['url'])) {
    return null;
  }

  return {
    version,
    notes: typeof notes === 'string' ? notes.slice(0, 1200) : '',
    minNative,
    bundle: { version, files },
    apk: { versionCode: apk['versionCode'], versionName: apk['versionName'].slice(0, 40), url: apk['url'] },
  };
}

export function compareVersions(a: string, b: string): number {
  const pa = a.split('.').map(Number);
  const pb = b.split('.').map(Number);
  for (let i = 0; i < 3; i++) {
    const d = (pa[i] ?? 0) - (pb[i] ?? 0);
    if (d !== 0) return Math.sign(d);
  }
  return 0;
}

export type UpdatePlan = { bundle: BundleRelease | null; apk: ApkRelease | null };

/**
 * An update installs inside the app whenever the installed APK can run it, and then that is
 * the only thing offered: a newer APK on top would send people to a download they do not
 * need. The APK is offered only when the new bundle requires it (the installed build is
 * older than `minNative`), because then it is the only way forward.
 */
export function planUpdate(manifest: UpdateManifest, runningVersion: string, nativeBuild: number): UpdatePlan {
  const fits = manifest.minNative <= nativeBuild;
  const newer = VERSION.test(runningVersion) ? compareVersions(manifest.version, runningVersion) > 0 : false;
  const apkRequired = !fits && manifest.apk.versionCode > nativeBuild;
  return { bundle: fits && newer ? manifest.bundle : null, apk: apkRequired ? manifest.apk : null };
}
