import { readFileSync } from 'node:fs';

/**
 * Widens the trip confirm ceiling from 30 seconds to a minute.
 *
 * `alter table` added the column with its original check, and SQLite cannot alter a
 * constraint, so the table is rebuilt. Settings holds one row, which makes this cheap,
 * but the row still has to survive: it carries the operator's thresholds.
 *
 * Usage: node scripts/widen-trip-confirm.mjs
 */

const env = Object.fromEntries(
  readFileSync(new URL('../.env', import.meta.url), 'utf8')
    .split('\n')
    .filter((line) => line.includes('=') && !line.trim().startsWith('#'))
    .map((line) => {
      const at = line.indexOf('=');
      return [line.slice(0, at).trim(), line.slice(at + 1).trim().replace(/^'|'$/g, '')];
    })
);

const URL_HTTP = env.DATABASE_URL.replace('libsql://', 'https://') + '/v2/pipeline';

async function run(sql) {
  const response = await fetch(URL_HTTP, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${env.DATABASE_AUTH_TOKEN}`,
      'content-type': 'application/json',
    },
    body: JSON.stringify({
      requests: [...sql.map((s) => ({ type: 'execute', stmt: { sql: s } })), { type: 'close' }],
    }),
  });

  const json = await response.json();
  const failed = (json.results ?? []).findIndex((r) => r.type === 'error');
  if (failed !== -1) {
    throw new Error(`${json.results[failed].error.message}\n  sql: ${sql[failed]}`);
  }

  return json.results;
}

const columns =
  'load_threshold_va, trip_threshold_va, temp_threshold_c, reclose_delay_seconds, ' +
  'trip_confirm_seconds, source_mode, created_at, updated_at';

const before = (await run([`select ${columns} from settings where id = 1`]))[0].response.result
  .rows[0]
  .map((c) => c.value);
console.log('before:', before.join(' | '));

await run([
  'begin immediate',

  `create table settings_new (
    id                    integer primary key check (id = 1),
    load_threshold_va     real not null default 900,
    trip_threshold_va     real not null default 980,
    temp_threshold_c      real not null default 40,
    reclose_delay_seconds integer not null default 30
        check (reclose_delay_seconds between 5 and 600),
    trip_confirm_seconds  integer not null default 3
        check (trip_confirm_seconds between 1 and 60),
    source_mode           text not null default 'hardware',
    created_at            text not null default (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
    updated_at            text not null default (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
    check (trip_threshold_va > load_threshold_va)
  )`,

  `insert into settings_new (id, ${columns}) select id, ${columns} from settings`,
  'drop table settings',
  'alter table settings_new rename to settings',

  'commit',
]);

const after = (await run([`select ${columns} from settings where id = 1`]))[0].response.result
  .rows[0]
  .map((c) => c.value);
console.log('after :', after.join(' | '));

if (before.join('|') !== after.join('|')) {
  throw new Error('the settings row changed during the rebuild');
}

// Prove the new ceiling rather than assume it.
for (const [value, expected] of [
  [60, 'accepted'],
  [61, 'refused'],
  [0, 'refused'],
]) {
  let got;
  try {
    await run([`update settings set trip_confirm_seconds = ${value} where id = 1`]);
    got = 'accepted';
  } catch {
    got = 'refused';
  }
  console.log(`  ${String(value).padStart(3)}s ${got}${got === expected ? '' : `  EXPECTED ${expected}`}`);
}

await run([`update settings set trip_confirm_seconds = ${before[4]} where id = 1`]);
console.log(`restored trip_confirm_seconds to ${before[4]}`);
