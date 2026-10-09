/** Shown for a sensor the board does not have (a genuine null). */
export const NO_DATA = 'No data';
/** Shown before the first reading arrives (value still undefined). */
export const LOADING = '--';

/**
 * A field is `undefined` only while the reading has not loaded yet, and `null`
 * when the board reported but has no sensor for it. Keeping the two apart means
 * "No data" is reserved for real missing sensors, never the loading gap.
 */
export function formatValue(value: number | null | undefined, digits: number): string {
  switch (true) {
    case value === undefined:
      return LOADING;
    case value === null:
      return NO_DATA;
    default:
      return value.toFixed(digits);
  }
}

export function formatValueWithUnit(
  value: number | null | undefined,
  digits: number,
  unit: string
): string {
  const text = formatValue(value, digits);
  return isPlaceholder(text) ? text : `${text} ${unit}`;
}

export function isPlaceholder(text: string): boolean {
  return text === NO_DATA || text === LOADING;
}
