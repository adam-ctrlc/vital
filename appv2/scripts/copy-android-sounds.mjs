// Copies the bundled alert tones into the Android project's res/raw, which is where a
// notification channel reads its sound from. Run after `cap add android`, and again
// whenever a tone is added or changed:
//
//   node scripts/copy-android-sounds.mjs
//
// A channel copies its sound in when it is created and never again, so a phone that
// already has a channel keeps the old sound until the app is reinstalled or the
// channel id is bumped in src/features/notifications/alert-sound.ts.
import { copyFileSync, existsSync, mkdirSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const source = join(root, 'public', 'sounds');
const android = join(root, 'android');
const target = join(android, 'app', 'src', 'main', 'res', 'raw');

if (!existsSync(android)) {
  console.error('No android/ project yet. Run `pnpm exec cap add android` first.');
  process.exit(1);
}

mkdirSync(target, { recursive: true });

const files = readdirSync(source).filter((name) => name.endsWith('.wav'));
for (const name of files) copyFileSync(join(source, name), join(target, name));

console.log(`Copied ${files.length} alert tones to ${target}`);
