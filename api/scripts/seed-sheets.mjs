import { createSign } from 'node:crypto';
import { readFileSync } from 'node:fs';
import path from 'node:path';

/**
 * Loads the Postgres export into the spreadsheet the API will read from.
 *
 * Node rather than Rust because it runs once. The API's own client is the thing that
 * has to be right; this only has to put the rows where that client expects them, and
 * the headers below are the contract between the two.
 *
 * Usage: node scripts/seed-sheets.mjs <key.json> <json-export-dir> <spreadsheet-id>
 */

const [KEY, DATA, SHEET_ID] = process.argv.slice(2);
const creds = JSON.parse(readFileSync(KEY, 'utf8'));

/**
 * Column orders, copied from src/sheets/schema.rs.
 *
 * Duplicated knowledge, and the one place this script can silently ruin the migration:
 * a column out of order here reads as the wrong field there, with no error anywhere.
 * Changing either side means changing both.
 */
const HEADERS = {
  readings: ['id', 'voltage_v', 'current_a', 'temperature_c', 'apparent_power_va', 'status', 'source', 'power_w', 'power_factor', 'frequency_hz', 'energy_kwh', 'relay_closed', 'recorded_at'],
  alerts: ['id', 'reading_id', 'kind', 'message', 'value', 'threshold', 'created_at', 'acknowledged_at', 'acknowledged_by', 'response_ms', 'last_notified_at'],
  users: ['id', 'email', 'username', 'password_hash', 'role', 'first_name', 'middle_name', 'last_name', 'created_at', 'updated_at'],
  settings: ['id', 'load_threshold_va', 'trip_threshold_va', 'temp_threshold_c', 'reclose_delay_seconds', 'source_mode', 'updated_at'],
  device_telemetry: ['id', 'device_id', 'firmware', 'ssid', 'ip_address', 'signal_dbm', 'uptime_seconds', 'relay_command', 'relay_locked_out', 'reported_at'],
  push_tokens: ['token', 'user_id', 'platform', 'channel_id', 'created_at'],
};

/**
 * Columns the export cannot have, because the migrations that added them were written
 * during this work and never applied to Postgres.
 *
 * Filled with what the running system would have produced rather than left blank, so
 * the seeded state is one the API could have reached on its own.
 */
const BACKFILL = {
  settings: { reclose_delay_seconds: 30 },
  device_telemetry: { relay_command: '', relay_locked_out: 'false' },
};

function assertion() {
  const now = Math.floor(Date.now() / 1000);
  const b64 = (value) => Buffer.from(JSON.stringify(value)).toString('base64url');
  const body =
    b64({ alg: 'RS256', typ: 'JWT' }) +
    '.' +
    b64({
      iss: creds.client_email,
      scope: 'https://www.googleapis.com/auth/spreadsheets',
      aud: creds.token_uri,
      iat: now,
      exp: now + 3600,
    });

  return `${body}.${createSign('RSA-SHA256').update(body).sign(creds.private_key, 'base64url')}`;
}

async function token() {
  const response = await fetch(creds.token_uri, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
      assertion: assertion(),
    }),
  });

  const json = await response.json();
  if (!response.ok) throw new Error(`auth failed: ${JSON.stringify(json)}`);

  return json.access_token;
}

async function call(auth, url, method = 'GET', body) {
  const response = await fetch(url, {
    method,
    headers: { authorization: `Bearer ${auth}`, 'content-type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined,
  });

  const json = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new Error(`${method} ${url.slice(0, 90)} -> ${response.status} ${JSON.stringify(json).slice(0, 200)}`);
  }

  return json;
}

/** Renders a value the way the Rust side parses it back. */
function cell(value) {
  if (value === null || value === undefined) return '';
  if (typeof value === 'boolean') return value ? 'true' : 'false';
  if (typeof value === 'object') return JSON.stringify(value);

  return String(value);
}

function rowsFor(header, records, backfill = {}) {
  return records.map((record) => header.map((column) => cell(record[column] ?? backfill[column])));
}

const load = (name) => {
  try {
    return JSON.parse(readFileSync(path.join(DATA, `${name}.json`), 'utf8') || '[]');
  } catch {
    return [];
  }
};

const auth = await token();
console.log('authenticated');

// Readings split by the month they were recorded in, which is what the API's rollover
// expects to find when it goes looking for a month that already has rows.
const readings = load('readings');
const byMonth = new Map();
for (const reading of readings) {
  const month = String(reading.recorded_at).slice(0, 7);
  if (!byMonth.has(month)) byMonth.set(month, []);
  byMonth.get(month).push(reading);
}

const plan = [
  ...[...byMonth.entries()].sort().map(([month, rows]) => ({
    tab: `readings-${month}`,
    header: HEADERS.readings,
    records: rows,
    backfill: {},
  })),
  ...['alerts', 'users', 'settings', 'device_telemetry', 'push_tokens'].map((name) => ({
    tab: name,
    header: HEADERS[name],
    records: load(name),
    backfill: BACKFILL[name] ?? {},
  })),
];

const existing = new Set(
  (
    await call(auth, `https://sheets.googleapis.com/v4/spreadsheets/${SHEET_ID}?fields=sheets.properties.title`)
  ).sheets?.map((sheet) => sheet.properties.title) ?? []
);

const missing = plan.filter((entry) => !existing.has(entry.tab));
if (missing.length > 0) {
  await call(auth, `https://sheets.googleapis.com/v4/spreadsheets/${SHEET_ID}:batchUpdate`, 'POST', {
    requests: missing.map((entry) => ({ addSheet: { properties: { title: entry.tab } } })),
  });
}

for (const entry of plan) {
  const values = [entry.header, ...rowsFor(entry.header, entry.records, entry.backfill)];

  await call(
    auth,
    `https://sheets.googleapis.com/v4/spreadsheets/${SHEET_ID}/values/${encodeURIComponent(entry.tab)}!A1?valueInputOption=RAW`,
    'PUT',
    { values }
  );

  console.log(`  ${entry.tab.padEnd(20)} ${entry.records.length} rows`);
}

console.log(`\nhttps://docs.google.com/spreadsheets/d/${SHEET_ID}/edit`);
