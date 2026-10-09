export function peso(value: number): string {
  return `₱${value.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

/** "45 min", "3 h 20 min", "2 d 4 h". */
export function formatMinutes(minutes: number): string {
  const whole = Math.round(minutes);
  if (whole < 60) return `${whole} min`;
  if (whole < 24 * 60) {
    const rest = whole % 60;
    return rest ? `${Math.floor(whole / 60)} h ${rest} min` : `${whole / 60} h`;
  }
  const hours = Math.floor((whole % (24 * 60)) / 60);
  return hours ? `${Math.floor(whole / (24 * 60))} d ${hours} h` : `${Math.floor(whole / (24 * 60))} d`;
}

/** "42 s", "14 min 3 s", "3 h 20 min". */
export function formatSeconds(seconds: number): string {
  if (seconds < 60) return `${Math.round(seconds)} s`;
  if (seconds < 3600) {
    const rest = Math.round(seconds % 60);
    return rest ? `${Math.floor(seconds / 60)} min ${rest} s` : `${Math.floor(seconds / 60)} min`;
  }
  return formatMinutes(seconds / 60);
}

export const WEEKDAYS_SHORT = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];

/** "4 PM", "12 AM". */
export function hourLabel(hour: number): string {
  const h = hour % 12 === 0 ? 12 : hour % 12;
  return `${h} ${hour < 12 ? 'AM' : 'PM'}`;
}

/** 0.00041 rather than 4.1e-4: these rates are usually far below 1. */
export function formatFactor(value: number | null): string {
  if (value === null) return 'No data';
  return `${value >= 10 ? value.toFixed(0) : Number(value.toPrecision(2))}\u00a0×`;
}

/** Hours of aging, with minutes or seconds when it is small. */
export function formatAgingHours(hours: number): string {
  if (hours >= 1) return `${hours.toFixed(1)} h`;
  if (hours * 60 >= 1) return `${(hours * 60).toFixed(1)} min`;
  return `${(hours * 3600).toFixed(1)} s`;
}

const MONTHS_SHORT = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

/** "Sep 24" from "2026-09-24", read as a calendar day rather than an instant. */
export function dateLabel(date: string): string {
  const [, month, day] = date.split('-').map(Number);
  return month && day ? `${MONTHS_SHORT[month - 1]} ${day}` : date;
}
