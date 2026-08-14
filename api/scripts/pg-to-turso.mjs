import { readFileSync } from 'node:fs';

/**
 * Copies the Postgres export into Turso.
 *
 * Node rather than Rust because it runs once, and against the HTTP API directly rather
 * than through the client the server uses: this has to work before that code compiles.
 *
 * Usage: node scripts/pg-to-turso.mjs <json-export-dir>
 * Reads DATABASE_URL and DATABASE_AUTH_TOKEN from api/.env.
 */

const DATA = process.argv[2];

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
const TOKEN = env.DATABASE_AUTH_TOKEN;

/**
 * Runs statements in one round trip.
 *
 * Batched because each round trip to Tokyo costs about 150 ms, and two and a half
 * thousand readings one at a time would be six minutes of latency and nothing else.
 */
async function run(statements) {
  const response = await fetch(URL_HTTP, {
    method: 'POST',
    headers: { authorization: `Bearer ${TOKEN}`, 'content-type': 'application/json' },
    body: JSON.stringify({
      requests: [...statements.map((s) => ({ type: 'execute', stmt: s })), { type: 'close' }],
    }),
  });

  const json = await response.json();
  if (!response.ok) throw new Error(`${response.status}: ${JSON.stringify(json).slice(0, 300)}`);

  const failures = (json.results ?? [])
    .map((r, i) => [i, r])
    .filter(([, r]) => r.type === 'error');

  if (failures.length > 0) {
    const [index, failure] = failures[0];
    throw new Error(
      `${failures.length} of ${statements.length} failed. First: ${failure.error.message}\n` +
        `  sql: ${statements[index].sql.slice(0, 160)}`
    );
  }

  return json.results;
}

const load = (name) => JSON.parse(readFileSync(`${DATA}/${name}.json`, 'utf8') || '[]');

/**
 * Renders one value as a libSQL argument.
 *
 * Postgres booleans arrive as true and false and SQLite stores 0 and 1; timestamps
 * arrive as ISO strings and stay strings, because the schema declares them TEXT.
 */
function arg(value) {
  if (value === null || value === undefined) return { type: 'null' };
  if (typeof value === 'boolean') return { type: 'integer', value: value ? '1' : '0' };
  if (typeof value === 'number') {
    return Number.isInteger(value)
      ? { type: 'integer', value: String(value) }
      : { type: 'float', value };
  }

  return { type: 'text', value: String(value) };
}

const insert = (table, columns, row) => ({
  sql: `insert or replace into ${table} (${columns.join(', ')}) values (${columns.map(() => '?').join(', ')})`,
  args: columns.map((column) => arg(row[column])),
});

// Order matters: alerts reference readings and users, push_tokens reference users, so a
// child inserted before its parent trips the foreign key.
const plan = [
  ['users', ['id', 'email', 'username', 'password_hash', 'role', 'first_name', 'middle_name', 'last_name', 'created_at', 'updated_at']],
  ['readings', ['id', 'voltage_v', 'current_a', 'temperature_c', 'apparent_power_va', 'power_w', 'power_factor', 'frequency_hz', 'energy_kwh', 'relay_closed', 'status', 'source', 'recorded_at', 'created_at', 'updated_at']],
  ['alerts', ['id', 'reading_id', 'kind', 'message', 'value', 'threshold', 'created_at', 'acknowledged_at', 'acknowledged_by', 'response_ms', 'last_notified_at', 'updated_at']],
  ['settings', ['id', 'load_threshold_va', 'trip_threshold_va', 'temp_threshold_c', 'reclose_delay_seconds', 'source_mode', 'created_at', 'updated_at']],
  ['device_telemetry', ['id', 'device_id', 'firmware', 'ssid', 'ip_address', 'signal_dbm', 'uptime_seconds', 'relay_command', 'relay_locked_out', 'reported_at']],
  ['push_tokens', ['token', 'user_id', 'platform', 'channel_id', 'created_at', 'updated_at']],
];

const BATCH = 100;

for (const [table, columns] of plan) {
  const rows = load(table);
  if (rows.length === 0) {
    console.log(`  ${table.padEnd(18)} 0 rows`);
    continue;
  }

  for (let at = 0; at < rows.length; at += BATCH) {
    await run(rows.slice(at, at + BATCH).map((row) => insert(table, columns, row)));
  }

  console.log(`  ${table.padEnd(18)} ${rows.length} rows`);
}

// Counted from the database rather than from what was sent, because a silent partial
// write is exactly the failure this is meant to rule out.
const counts = await run(plan.map(([table]) => ({ sql: `select count(*) from ${table}` })));
console.log('\nin Turso now:');
plan.forEach(([table], index) => {
  console.log(`  ${table.padEnd(18)} ${counts[index].response.result.rows[0][0].value}`);
});
