/** The envelope every paginated list endpoint returns. */
export type Page<T> = {
  rows: T[];
  total: number;
  limit: number;
  offset: number;
};

export const PAGE_SIZE = 20;

export function pageCount(total: number, limit: number): number {
  return Math.max(1, Math.ceil(total / Math.max(limit, 1)));
}

export function pageIndex(offset: number, limit: number): number {
  return Math.floor(offset / Math.max(limit, 1));
}

/** Inclusive 1-based range of the current window, clamped to what exists. */
export function pageRange(offset: number, limit: number, total: number) {
  const from = total === 0 ? 0 : offset + 1;
  const to = Math.min(offset + limit, total);

  return { from, to };
}

/**
 * How many numbered cells the row may ever show.
 *
 * The row has to survive a narrow phone alongside two arrows, so this is a hard budget
 * rather than a target: the first and last page always take one each, leaving three for
 * the window around the current page.
 */
export const MAX_PAGES = 5;

/**
 * The page numbers to show, with 'gap' markers where a run is elided.
 *
 * Always keeps the first and last page so the ends stay reachable in one tap, and
 * spends the remaining three slots on the current page and its neighbours. Which side
 * the gap falls on depends on where the current page sits:
 *
 *   near the start   1 2 3 4 ... 20
 *   in the middle    1 ... 9 10 11 ... 20
 *   near the end     1 ... 17 18 19 20
 *
 * Every case shows the same number of cells, so the row never changes width as you
 * page through it. The arrows do the single steps.
 *
 * @param current 1-based current page.
 * @param maxPages How many numbers may be shown. The caller lowers this on a narrow
 *   screen, where five cells plus two arrows and two ellipses do not fit.
 */
export function pageItems(
  current: number,
  totalPages: number,
  maxPages: number = MAX_PAGES
): (number | 'gap')[] {
  if (totalPages <= 1) return [1];

  // Never below three: the first page, the last page, and the one you are on. Fewer
  // than that cannot show all three at once.
  const budget = Math.max(3, maxPages);

  // Everything fits in the budget, so eliding would hide pages for no gain.
  if (totalPages <= budget) {
    return Array.from({ length: totalPages }, (_, i) => i + 1);
  }

  // The slots left between the two ends. The window slides but never shrinks, which is
  // what keeps the row a constant width.
  const window = budget - 2;
  const half = Math.floor(window / 2);

  let start = Math.max(2, current - half);
  let end = start + window - 1;

  // Clamped against the last page rather than centred blindly: near the end the window
  // would otherwise run past it and come back short.
  if (end > totalPages - 1) {
    end = totalPages - 1;
    start = end - window + 1;
  }

  const items: (number | 'gap')[] = [1];

  if (start > 2) items.push('gap');
  for (let page = start; page <= end; page += 1) items.push(page);
  if (end < totalPages - 1) items.push('gap');

  items.push(totalPages);

  return items;
}
