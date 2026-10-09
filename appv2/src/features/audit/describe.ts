import type { AuditEvent } from '@/features/audit/types';

type Change = { from: unknown; to: unknown };

const SETTINGS: Record<string, { label: string; format: (value: unknown) => string }> = {
  loadThresholdVa: { label: 'alarm threshold', format: (v) => `${v} VA` },
  tripThresholdVa: { label: 'trip threshold', format: (v) => `${v} VA` },
  tempThresholdC: { label: 'temperature threshold', format: (v) => `${v} °C` },
  recloseDelaySeconds: { label: 'reclose delay', format: (v) => `${v} s` },
  tripConfirmSeconds: { label: 'trip delay', format: (v) => `${v} s` },
  energyRatePerKwh: { label: 'electricity rate', format: (v) => `₱${Number(v).toFixed(2)} per kWh` },
  nominalVoltageV: { label: 'nominal voltage', format: (v) => `${v} V` },
};

const ACCOUNT_FIELDS: Record<string, string> = {
  firstName: 'first name',
  middleName: 'middle name',
  lastName: 'last name',
  email: 'email',
  username: 'username',
  role: 'role',
  password: 'password',
};

const SOURCE: Record<string, string> = { hardware: 'the ESP32', simulation: 'the simulation' };

function changes(detail: Record<string, unknown> | null): [string, Change][] {
  return Object.entries(detail ?? {}).filter(
    (entry): entry is [string, Change] => typeof entry[1] === 'object' && entry[1] !== null && 'to' in entry[1]
  );
}

function list(items: string[]) {
  return items.length > 1 ? `${items.slice(0, -1).join(', ')} and ${items[items.length - 1]}` : (items[0] ?? '');
}

function settingText([field, { from, to }]: [string, Change]) {
  const known = SETTINGS[field];
  if (!known) return `changed ${field}`;
  return from === null || from === undefined
    ? `set the ${known.label} to ${known.format(to)}`
    : `changed the ${known.label} from ${known.format(from)} to ${known.format(to)}`;
}

/** Everything after the actor's name, such as "changed the trip threshold from 980 VA to 900 VA". */
export function describeAction(event: AuditEvent): string {
  const detail = event.detail ?? {};
  const name = event.target ?? (typeof detail.username === 'string' ? `@${detail.username}` : 'an account');

  switch (event.action) {
    case 'settings.update': {
      const changed = changes(event.detail);
      return changed.length ? list(changed.map(settingText)) : 'saved the settings';
    }
    case 'settings.source':
      return `switched readings to ${SOURCE[String(detail.to)] ?? String(detail.to)}`;
    case 'relay.open':
      return 'opened the relay';
    case 'relay.close':
      return 'closed the relay';
    case 'user.create':
      return `created ${name}${detail.role === 'admin' ? ' as an admin' : ''}`;
    case 'user.update': {
      const changed = changes(event.detail);
      const role = changed.find(([field]) => field === 'role');
      const fields = changed.filter(([field]) => field !== 'role').map(([field]) => ACCOUNT_FIELDS[field] ?? field);
      const parts: string[] = [];
      // The name once; after that, "their".
      const whose = () => (parts.length ? 'their' : `${name}'s`);
      if (role) parts.push(`made ${name} ${role[1].to === 'admin' ? 'an admin' : 'a user'}`);
      if (fields.includes('password')) parts.push(`reset ${whose()} password`);
      const rest = fields.filter((field) => field !== 'password');
      if (rest.length) parts.push(`changed ${whose()} ${list(rest)}`);
      return parts.length ? list(parts) : `updated ${name}`;
    }
    case 'user.delete':
      return `removed ${name}`;
    case 'user.approve':
      return `approved ${name}`;
    case 'account.update': {
      const fields = changes(event.detail).map(([field]) => ACCOUNT_FIELDS[field] ?? field);
      return fields.length ? `changed their ${list(fields)}` : 'updated their profile';
    }
    case 'account.password':
      return 'changed their password';
    default:
      return event.action;
  }
}

export function auditCategory(action: string): 'settings' | 'relay' | 'user' | 'account' | 'other' {
  const prefix = action.split('.')[0];
  return prefix === 'settings' || prefix === 'relay' || prefix === 'user' || prefix === 'account' ? prefix : 'other';
}
