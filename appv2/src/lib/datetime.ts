const MONTHS = [
  'January',
  'February',
  'March',
  'April',
  'May',
  'June',
  'July',
  'August',
  'September',
  'October',
  'November',
  'December',
];

/**
 * "July 17, 2026 6:08 PM".
 *
 * Built by hand rather than with toLocaleString: on Android the locale data can
 * fall back to a numeric format like 17/7/2026 and a lowercase "pm".
 */
export function formatDateTime(iso: string): string {
  const at = new Date(iso);
  if (Number.isNaN(at.getTime())) return '--';

  const month = MONTHS[at.getMonth()];
  const day = at.getDate();
  const year = at.getFullYear();
  const { hour, meridiem } = twelveHour(at.getHours());
  const minute = String(at.getMinutes()).padStart(2, '0');

  return `${month} ${day}, ${year} ${hour}:${minute} ${meridiem}`;
}

/** "July 17, 6:08 PM" — same clock, no year, for dense rows. */
export function formatShortDateTime(iso: string): string {
  const at = new Date(iso);
  if (Number.isNaN(at.getTime())) return '--';

  const month = MONTHS[at.getMonth()];
  const day = at.getDate();
  const { hour, meridiem } = twelveHour(at.getHours());
  const minute = String(at.getMinutes()).padStart(2, '0');

  return `${month} ${day}, ${hour}:${minute} ${meridiem}`;
}

/** "Jul 17" — compact enough for a chart axis. */
export function formatDayLabel(iso: string): string {
  const at = new Date(iso);
  if (Number.isNaN(at.getTime())) return '--';

  return `${MONTHS[at.getMonth()].slice(0, 3)} ${at.getDate()}`;
}

const WEEKDAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];

/** "Friday, October 9", for the top of a page. */
export function formatLongDate(at: Date = new Date()): string {
  return `${WEEKDAYS[at.getDay()]}, ${MONTHS[at.getMonth()]} ${at.getDate()}`;
}

/** "6:08 PM", for a row already grouped under its day. */
export function formatTime(iso: string): string {
  const at = new Date(iso);
  if (Number.isNaN(at.getTime())) return '--';

  const { hour, meridiem } = twelveHour(at.getHours());
  return `${hour}:${String(at.getMinutes()).padStart(2, '0')} ${meridiem}`;
}

/** A local calendar-day key, for grouping rows by day. */
export function dayKey(iso: string): string {
  const at = new Date(iso);
  return `${at.getFullYear()}-${at.getMonth()}-${at.getDate()}`;
}

/** "Today", "Yesterday", or "October 7" (with the year once it is not this year). */
export function formatDayHeading(iso: string, now: Date = new Date()): string {
  const at = new Date(iso);
  if (Number.isNaN(at.getTime())) return '--';

  const startOf = (date: Date) => new Date(date.getFullYear(), date.getMonth(), date.getDate()).getTime();
  const days = Math.round((startOf(now) - startOf(at)) / 86_400_000);
  if (days === 0) return 'Today';
  if (days === 1) return 'Yesterday';

  const label = `${MONTHS[at.getMonth()]} ${at.getDate()}`;
  return at.getFullYear() === now.getFullYear() ? label : `${label}, ${at.getFullYear()}`;
}

function twelveHour(hours: number) {
  const meridiem = hours < 12 ? 'AM' : 'PM';
  const hour = hours % 12 === 0 ? 12 : hours % 12;

  return { hour, meridiem };
}
