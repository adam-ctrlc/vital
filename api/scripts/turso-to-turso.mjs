import { readFileSync } from 'node:fs';

/**
 * Copies one Turso database into another.
 *
 * Written for an account move rather than a region move: both ends speak the same
 * dialect and hold the same schema, so this applies `schema.sql` to the target and
 * then replays every row. Timestamps are already text in the shape the schema wants,
 * so nothing is reformatted on the way through.
 *
 * The source is whatever `api/.env` currently points at. The target is a small JSON
 * file, `{ "url": "libsql://…", "token": "…" }`, kept outside the repo so a credential
 * never lands in git.
 *
 * Usage: node scripts/turso-to-turso.mjs <target-json>
 */

const TARGET_FILE = process.argv[2];
if (!TARGET_FILE) {
  console.error('usage: node scripts/turso-to-turso.mjs <target-json>');
  process.exit(1);
}

const env = Object.fromEntries(
  readFileSync(new URL('../.env', import.meta.url), 'utf8')
    .split('\n')
    .filter((line) => line.includes('=') && !line.trim().startsWith('#'))
    .map((line) => {
      const at = line.indexOf('=');
      return [line.slice(0, at).trim(), line.slice(at + 1).trim().replace(/^'|'$/g, '')];
    })
);

const target = JSON.parse(readFileSync(TARGET_FILE, 'utf8'));

const endpoint = (url) => url.replace('libsql://', 'https://').replace(/\/+$/, '') + '/v2/pipeline';

const SOURCE = { url: endpoint(env.DATABASE_URL), token: env.DATABASE_AUTH_TOKEN };
const TARGET = { url: endpoint(target.url), token: target.token };

async function run(db, statements) {
  const response = await fetch(db.url, {
    method: 'POST',
    headers: { authorization: `Bearer ${db.token}`, 'content-type': 'application/json' },
    body: JSON.stringify({
      requests: [...statements.map((s) => ({ type: 'execute', stmt: s })), { type: 'close' }],
    }),
  });

  const json = await response.json();
  if (!response.ok) throw new Error(`${response.status}: ${JSON.stringify(json).slice(0, 300)}`);

  const failed = (json.results ?? []).findIndex((r) => r.type === 'error');
  if (failed !== -1) {
    const sql = typeof statements[failed] === 'string' ? statements[failed] : statements[failed].sql;
    throw new Error(`${json.results[failed].error.message}\n  sql: ${String(sql).slice(0, 160)}`);
  }

  return json.results;
}

const sql = (db, ...text) => run(db, text.map((s) => ({ sql: s })));
const count = async (db, table) =>
  Number((await sql(db, `select count(*) from ${table}`))[0].response.result.rows[0][0].value);

/** Splits the schema the same way the server does: by statement, dropping comment lines. */
function statements(schema) {
  return schema
    .split(';\n')
    .map((chunk) =>
      chunk
        .split('\n')
        .filter((line) => !line.trimStart().startsWith('--'))
        .join('\n')
        .trim()
    )
    .filter((s) => s.length > 0);
}

// Order matters: alerts reference readings and users, push_tokens reference users, so a
// child copied before its parent trips the foreign key that was just restored.
const TABLES = [
  ['users', ['id', 'email', 'username', 'password_hash', 'role', 'first_name', 'middle_name', 'last_name', 'created_at', 'updated_at']],
  ['readings', ['id', 'voltage_v', 'current_a', 'temperature_c', 'apparent_power_va', 'power_w', 'power_factor', 'frequency_hz', 'energy_kwh', 'relay_closed', 'status', 'source', 'recorded_at', 'created_at', 'updated_at']],
  ['alerts', ['id', 'reading_id', 'kind', 'message', 'value', 'threshold', 'created_at', 'acknowledged_at', 'acknowledged_by', 'response_ms', 'last_notified_at', 'updated_at']],
  ['settings', ['id', 'load_threshold_va', 'trip_threshold_va', 'temp_threshold_c', 'reclose_delay_seconds', 'trip_confirm_seconds', 'source_mode', 'created_at', 'updated_at']],
  ['device_telemetry', ['id', 'device_id', 'firmware', 'ssid', 'ip_address', 'signal_dbm', 'uptime_seconds', 'relay_command', 'relay_locked_out', 'reported_at']],
  ['push_tokens', ['token', 'user_id', 'platform', 'channel_id', 'created_at', 'updated_at']],
];

const BATCH = 100;

console.log(`source: ${env.DATABASE_URL}`);
console.log(`target: ${target.url}\n`);

console.log('applying the schema to the target');
const schema = readFileSync(new URL('../schema.sql', import.meta.url), 'utf8');
const applied = statements(schema);
await run(TARGET, applied.map((s) => ({ sql: s })));
console.log(`  ${applied.length} statements applied`);

const objects = await sql(
  TARGET,
  "select name from sqlite_master where type in ('table','index') and name not like 'sqlite_%' order by type, name"
);
console.log(`  target now holds: ${objects[0].response.result.rows.map((r) => r[0].value).join(', ')}\n`);

console.log('copying rows');
const expected = {};
for (const [table, columns] of TABLES) {
  const rows = (await sql(SOURCE, `select ${columns.join(', ')} from ${table}`))[0].response.result
    .rows;
  expected[table] = rows.length;

  if (rows.length === 0) {
    console.log(`  ${table.padEnd(18)} 0 rows`);
    continue;
  }

  // `insert or replace` so a re-run is a no-op rather than a pile of conflicts. The
  // values come back from the source already typed, so they go straight back out.
  for (let at = 0; at < rows.length; at += BATCH) {
    await run(
      TARGET,
      rows.slice(at, at + BATCH).map((row) => ({
        sql: `insert or replace into ${table} (${columns.join(', ')}) values (${columns.map(() => '?').join(', ')})`,
        args: row,
      }))
    );
  }

  console.log(`  ${table.padEnd(18)} ${rows.length} rows`);
}

// Counted from the target rather than from what was sent, because a silent partial
// write is exactly the failure this is meant to rule out.
console.log('\nverifying');
let ok = true;
for (const [table] of TABLES) {
  const got = await count(TARGET, table);
  const want = expected[table];
  if (got !== want) ok = false;
  console.log(`  ${table.padEnd(18)} ${String(got).padStart(5)} / ${want}${got === want ? '' : '   MISMATCH'}`);
}

if (!ok) {
  console.error('\nrow counts differ, do not switch over');
  process.exit(1);
}

console.log('\nevery table matches.');
