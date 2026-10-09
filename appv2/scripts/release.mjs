// Publishes a new version of Vital to the public releases repo, where installed apps look
// for updates (see src/lib/updates).
//
//   pnpm release --notes "What changed"          live update, downloaded inside the app
//   pnpm release:apk --notes "What changed"      also builds and offers a new APK
//   add --needs-new-apk when the app now depends on native changes in that APK
//   add --dry-run to build nothing and upload nothing, only write release/ from the current dist
//   add --local (with --apk) to build and sign the APK on this computer instead of in GitHub Actions
//
// A new APK is needed only when Android itself changes: the app name or icon, permissions, a new
// Capacitor plugin, a Capacitor upgrade. It is built and signed in GitHub Actions (this script
// starts that run and then executes there), since the signing key lives in the repo's secrets.
//
// Every file of the app is listed with its SHA-256 hash. A file is uploaded once, the first time
// its content appears; later releases point back at that upload, and phones copy any file they
// already have instead of downloading it again.

import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const SOURCE_REPO = 'adam-ctrlc/vital';
/** The branch APK releases are built from in GitHub Actions. */
const BRANCH = 'master';
const REPO = 'adam-ctrlc/vital-releases';
const DOWNLOAD = `https://github.com/${REPO}/releases/download`;
const DIST = join(ROOT, 'dist');
const OUT = join(ROOT, 'release');
const UPLOAD_BATCH = 20;
const IN_CI = process.env.GITHUB_ACTIONS === 'true';

const args = process.argv.slice(2);
const withApk = args.includes('--apk');
const needsNewApk = args.includes('--needs-new-apk');
const dryRun = args.includes('--dry-run');
// Builds the APK on this computer instead of in GitHub Actions. Needs the signing key's
// ANDROID_KEYSTORE_* variables in the environment (see ~/.vital-release/keystore.env).
const local = args.includes('--local');
const notesAt = args.indexOf('--notes');
const notes = notesAt >= 0 ? (args[notesAt + 1] ?? '').trim() : '';

function fail(message) {
  console.error(`\nRelease stopped: ${message}`);
  process.exit(1);
}

function run(cmd, cmdArgs, options = {}) {
  execFileSync(cmd, cmdArgs, { stdio: 'inherit', cwd: ROOT, ...options });
}

function capture(cmd, cmdArgs) {
  return execFileSync(cmd, cmdArgs, {
    encoding: 'utf8',
    cwd: ROOT,
    stdio: ['ignore', 'pipe', 'pipe'],
  }).trim();
}

function compareVersions(a, b) {
  const pa = a.split('.').map(Number);
  const pb = b.split('.').map(Number);
  for (let i = 0; i < 3; i++)
    if ((pa[i] ?? 0) !== (pb[i] ?? 0)) return Math.sign((pa[i] ?? 0) - (pb[i] ?? 0));
  return 0;
}

function nextPatch(version) {
  const [major = 0, minor = 0, patch = 0] = version.split('.').map(Number);
  return `${major}.${minor}.${patch + 1}`;
}

/** Android versionCode from the version: 1.2.3 -> 10203. Always grows with the version. */
function versionCodeOf(version) {
  const [major = 0, minor = 0, patch = 0] = version.split('.').map(Number);
  return major * 10000 + minor * 100 + patch;
}

function packageVersion() {
  return JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8')).version;
}

/** Writes the version into package.json, keeping its formatting. */
function setPackageVersion(version) {
  const path = join(ROOT, 'package.json');
  const text = readFileSync(path, 'utf8');
  writeFileSync(path, text.replace(/"version":\s*"[^"]*"/, `"version": "${version}"`));
}

if (!notes && !dryRun) fail('add release notes: --notes "What changed"');

// ---------- APK releases run in GitHub Actions, where the signing key is ----------

if (withApk && !IN_CI && !dryRun && !local) {
  if (capture('git', ['status', '--porcelain']))
    fail('commit your changes first; the APK is built from what is pushed');
  run('git', ['fetch', '-q', 'origin', BRANCH]);
  if (capture('git', ['rev-parse', 'HEAD']) !== capture('git', ['rev-parse', `origin/${BRANCH}`])) {
    fail(`push your commits to ${BRANCH} first; the APK is built from what is pushed`);
  }
  run('gh', [
    'workflow',
    'run',
    'release.yml',
    '--repo',
    SOURCE_REPO,
    '--ref',
    BRANCH,
    '-f',
    `notes=${notes}`,
    '-f',
    `needs_new_apk=${needsNewApk}`,
  ]);
  console.log('\nThe APK is being built and signed in GitHub Actions. Follow it with:');
  console.log(
    `  gh run watch --repo ${SOURCE_REPO} $(gh run list --repo ${SOURCE_REPO} --workflow release.yml --limit 1 --json databaseId --jq '.[0].databaseId')`,
  );
  console.log('When it finishes, run git pull (the version number changes).');
  process.exit(0);
}

// ---------- previous release ----------

if (!dryRun) {
  try {
    execFileSync('gh', ['auth', 'status'], { stdio: 'pipe' });
  } catch {
    fail('GitHub CLI is not logged in. Run: gh auth login');
  }
}

// "No releases yet" and "could not reach GitHub" must not look the same: mistaking an outage
// for a first release would re-upload everything and reset the minimum APK version.
// Releases made before live updates have no latest.json; they still count for version numbers.
function previousRelease() {
  let latest;
  try {
    latest = JSON.parse(capture('gh', ['release', 'view', '--repo', REPO, '--json', 'tagName,assets']));
  } catch (err) {
    if (String(err.stderr ?? '').includes('release not found')) return { tag: null, manifest: null };
    fail(`could not read releases of ${REPO}. Check the connection and gh auth status.`);
  }
  const tag = latest.tagName.replace(/^v/, '');
  if (!latest.assets.some((a) => a.name === 'latest.json')) return { tag, manifest: null };
  const dir = join(OUT, '.previous');
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(dir, { recursive: true });
  try {
    execFileSync(
      'gh',
      ['release', 'download', `v${tag}`, '--repo', REPO, '--pattern', 'latest.json', '--dir', dir],
      { stdio: 'pipe' },
    );
    return { tag, manifest: JSON.parse(readFileSync(join(dir, 'latest.json'), 'utf8')) };
  } catch {
    fail('the latest release has a latest.json that could not be read');
  }
}

const { tag: lastTag, manifest: previous } = dryRun ? { tag: null, manifest: null } : previousRelease();
if (!previous && !withApk && !dryRun) {
  fail(
    'the first live-update release must include an APK (it adds the updater): pnpm release:apk --notes "…"',
  );
}

// A version already published is never reused: move past the last release unless package.json
// was already set beyond it by hand (editing package.json, for example).
const lastVersion = previous?.version ?? lastTag;
if (!dryRun && lastVersion && compareVersions(packageVersion(), lastVersion) <= 0) {
  setPackageVersion(nextPatch(lastVersion));
}
const version = packageVersion();
const versionCode = versionCodeOf(version);
const versionName = version;

// ---------- build ----------

if (!dryRun) run('pnpm', ['build']);
if (!existsSync(join(DIST, 'index.html'))) fail('dist/index.html is missing; the web build did not run');

const stage = join(OUT, `v${version}`);
rmSync(stage, { recursive: true, force: true });
mkdirSync(stage, { recursive: true });

const apkName = `vital-v${version}.apk`;
if (withApk && !dryRun) {
  if (!process.env.ANDROID_KEYSTORE_PATH)
    fail('ANDROID_KEYSTORE_PATH is not set; sign in GitHub Actions, or load ~/.vital-release/keystore.env with --local');
  run('pnpm', ['exec', 'cap', 'sync', 'android']);
  // The alert tones live in Android's res/raw, where notification channels can play them.
  run('node', ['scripts/copy-android-sounds.mjs']);
  run(join(ROOT, 'android', 'gradlew'), ['assembleRelease', '--no-daemon'], {
    cwd: join(ROOT, 'android'),
    env: { ...process.env, APP_VERSION_NAME: versionName, APP_VERSION_CODE: String(versionCode) },
  });
  copyFileSync(
    join(ROOT, 'android', 'app', 'build', 'outputs', 'apk', 'release', 'app-release.apk'),
    join(stage, apkName),
  );
}

// ---------- manifest ----------

function listFiles(dir) {
  const out = [];
  for (const name of readdirSync(dir)) {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) out.push(...listFiles(path));
    else out.push(path);
  }
  return out;
}

function sha256(path) {
  return createHash('sha256').update(readFileSync(path)).digest('hex');
}

const known = new Map((previous?.bundle?.files ?? []).map((f) => [f.hash, f.url]));
const uploads = new Map();
const files = listFiles(DIST).map((path) => {
  const hash = sha256(path);
  const name = relative(DIST, path).split(sep).join('/');
  let url = known.get(hash);
  if (!url) {
    url = `${DOWNLOAD}/v${version}/f-${hash}`;
    uploads.set(hash, path);
  }
  return { name, hash, url };
});
for (const [hash, path] of uploads) copyFileSync(path, join(stage, `f-${hash}`));

// A dry run with no earlier manifest lists a placeholder APK so latest.json stays complete.
const apk =
  withApk || (dryRun && !previous)
    ? { versionCode, versionName, url: `${DOWNLOAD}/v${version}/${apkName}` }
    : previous?.apk;
if (!apk) fail('no APK to list in latest.json');
const manifest = {
  version,
  notes,
  // The oldest APK that can run this bundle: it moves up only when an APK is required.
  minNative: withApk && (needsNewApk || !previous) ? versionCode : (previous?.minNative ?? versionCode),
  bundle: { version, files },
  apk,
};
writeFileSync(join(stage, 'latest.json'), JSON.stringify(manifest, null, 2));

const changedBytes = [...uploads.values()].reduce((sum, path) => sum + statSync(path).size, 0);
console.log(
  `\nVersion ${version}: ${files.length} files, ${uploads.size} new (${(changedBytes / 1048576).toFixed(1)} MB to upload).`,
);
if (dryRun) {
  console.log(`Dry run: wrote ${relative(ROOT, stage)} and uploaded nothing.`);
  process.exit(0);
}

// ---------- publish ----------

// The release stays a draft until every file is up, so no phone ever reads a latest.json
// that points at files still uploading.
const tag = `v${version}`;
const notesFile = join(OUT, `notes-${version}.txt`);
writeFileSync(notesFile, notes);
run('gh', [
  'release',
  'create',
  tag,
  '--repo',
  REPO,
  '--title',
  `Vital ${version}`,
  '--notes-file',
  notesFile,
  '--draft',
]);
const assets = readdirSync(stage).map((name) => join(stage, name));
for (let i = 0; i < assets.length; i += UPLOAD_BATCH) {
  run('gh', ['release', 'upload', tag, '--repo', REPO, '--clobber', ...assets.slice(i, i + UPLOAD_BATCH)]);
}
run('gh', ['release', 'edit', tag, '--repo', REPO, '--draft=false', '--latest']);

console.log(`\nPublished ${tag}. Phones pick it up the next time Vital opens.`);
if (withApk) console.log(`New APK: ${DOWNLOAD}/${tag}/${apkName}`);
if (!IN_CI) console.log('Remember to commit and push the source (the version number changed).');
