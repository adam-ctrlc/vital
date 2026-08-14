import { readFileSync } from 'node:fs';

/**
 * Restores the two `on delete set null` rules the alerts table lost.
 *
 * The Postgres schema had them and the SQLite translation dropped them, so both
 * foreign keys fell back to the default, which is to refuse. Deleting any user who
 * had ever acknowledged an alert failed with SQLITE_CONSTRAINT and a 500.
 *
 * SQLite cannot alter a constraint, so the table is rebuilt: new table, copy, drop,
 * rename, recreate indexes. Nothing references alerts, so dropping it is safe.
 *
 * Usage: node scripts/fix-alert-foreign-keys.mjs
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

const count = async (sql) => (await run([sql]))[0].response.result.rows[0][0].value;

const before = await count('select count(*) from alerts');
const beforeAcked = await count('select count(*) from alerts where acknowledged_at is not null');
console.log(`before: ${before} alerts, ${beforeAcked} acknowledged`);

// One request so it is one connection, wrapped so a failure part way leaves the old
// table in place rather than half a rebuild.
await run([
  'begin immediate',

  `create table alerts_new (
    id               integer primary key autoincrement,
    reading_id       integer references readings (id) on delete set null,
    kind             text not null check (kind in ('overload', 'temperature')),
    message          text not null,
    value            real not null,
    threshold        real not null,
    created_at       text not null default (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
    acknowledged_at  text,
    acknowledged_by  text references users (id) on delete set null,
    response_ms      integer,
    last_notified_at text,
    updated_at       text not null default (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
  )`,

  // Columns named rather than `select *`, so a future column added to one and not the
  // other fails here instead of silently shifting every value one place along.
  `insert into alerts_new (id, reading_id, kind, message, value, threshold, created_at,
                           acknowledged_at, acknowledged_by, response_ms, last_notified_at, updated_at)
   select id, reading_id, kind, message, value, threshold, created_at,
          acknowledged_at, acknowledged_by, response_ms, last_notified_at, updated_at
   from alerts`,

  'drop table alerts',
  'alter table alerts_new rename to alerts',

  'create index if not exists alerts_created_at_idx on alerts (created_at desc)',
  'create index if not exists alerts_active_idx on alerts (acknowledged_at) where acknowledged_at is null',
  // The guarantee that stops one ongoing overload pushing to every phone every few
  // seconds. Dropped with the old table, so it has to come back with the new one.
  'create unique index if not exists alerts_one_active_per_kind on alerts (kind) where acknowledged_at is null',

  'commit',
]);

const after = await count('select count(*) from alerts');
const afterAcked = await count('select count(*) from alerts where acknowledged_at is not null');
console.log(`after : ${after} alerts, ${afterAcked} acknowledged`);

if (after !== before || afterAcked !== beforeAcked) {
  throw new Error('row counts changed, investigate before trusting this');
}

// Read the rules back rather than trusting the create above.
const fks = await run(['select sql from sqlite_master where type = \'table\' and name = \'alerts\'']);
const ddl = fks[0].response.result.rows[0][0].value;
console.log(`on delete set null rules now present: ${(ddl.match(/on delete set null/g) ?? []).length} of 2`);

const idx = await run([
  "select name from sqlite_master where type = 'index' and tbl_name = 'alerts' and name not like 'sqlite_%' order by name",
]);
console.log('indexes:', idx[0].response.result.rows.map((r) => r[0].value).join(', '));
