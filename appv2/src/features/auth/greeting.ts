import type { Role, User } from '@/features/auth/types';

const MANILA_OFFSET_HOURS = 8;

type TimeOfDay = 'morning' | 'afternoon' | 'evening';

/** Hour of day at UTC+8, so the greeting matches the clock the API stamps readings with. */
function manilaHour(now: Date): number {
  return Math.floor(now.getTime() / 3_600_000 + MANILA_OFFSET_HOURS) % 24;
}

function timeOfDay(hour: number): TimeOfDay {
  switch (true) {
    case hour < 12:
      return 'morning';
    case hour < 18:
      return 'afternoon';
    default:
      return 'evening';
  }
}

function greetingFor(part: TimeOfDay): string {
  switch (part) {
    case 'morning':
      return 'Good morning';
    case 'afternoon':
      return 'Good afternoon';
    case 'evening':
      return 'Good evening';
  }
}

/** Falls back to the email local part so an account with blank names still greets sensibly. */
function displayName(user: User | null): string {
  const full = user?.fullName?.trim();
  if (full) return full;

  const local = user?.email?.split('@')[0];
  return local ? local : 'Guest';
}

function subtitleFor(role: Role | undefined): string {
  switch (role) {
    case 'admin':
      return 'You have full control of the 1 kVA transformer.';
    case 'user':
      return 'Here is the live status of the 1 kVA transformer.';
    default:
      return 'Connecting to the 1 kVA transformer.';
  }
}

export function greet(user: User | null, now: Date = new Date()) {
  return {
    greeting: `${greetingFor(timeOfDay(manilaHour(now)))}, ${displayName(user)}`,
    subtitle: subtitleFor(user?.role),
  };
}
