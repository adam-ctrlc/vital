import { ArrowRightIcon, CaretLeftIcon, CaretRightIcon, type Icon } from '@phosphor-icons/react';
import { useEffect, useState } from 'react';

import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';
import { MAX_PAGES, pageCount, pageIndex, pageItems, pageRange } from '@/lib/pagination';

/**
 * Cell widths in pixels, matching the classes used below.
 *
 * Kept as numbers because the row has to know whether it fits before it renders, and a
 * class name cannot be measured. They must be changed together with the classes.
 */
const ARROW = 40; // w-10
const NUMBER = 36; // w-9
const GAP = 28; // w-7

/**
 * The width of the element the returned ref is attached to, kept current as it resizes.
 *
 * A callback ref rather than an object one: the pager renders nothing until there is a
 * second page, so the element can appear long after mount, and an effect that ran once
 * would never see it.
 */
function useWidth() {
  const [element, setElement] = useState<HTMLElement | null>(null);
  const [width, setWidth] = useState(() => window.innerWidth);

  useEffect(() => {
    if (!element) return;

    const observer = new ResizeObserver(([entry]) => setWidth(entry.contentRect.width));
    observer.observe(element);
    return () => observer.disconnect();
  }, [element]);

  return [setElement, width] as const;
}

type PagerProps = {
  total: number;
  limit: number;
  offset: number;
  onOffsetChange: (offset: number) => void;
  noun?: string;
  /** Called when the jump input is focused, so the page can scroll it above the keyboard. */
  onInputFocus?: () => void;
};

/**
 * Numbered pagination flanked by icon-only prev/next arrows. Keeps the first and last
 * page plus the current one and its neighbours, eliding the rest with an ellipsis so
 * it stays one compact row.
 *
 * Drawn as a single joined group: one border and one radius around the outside, with
 * the cells divided by hairlines rather than separated by gaps. The radius therefore
 * belongs to the group, not the cells, which is why the arrows are square here and the
 * rounded ends come from the container clipping them.
 */
export function Pager({
  total,
  limit,
  offset,
  onOffsetChange,
  noun = 'record',
  onInputFocus,
}: PagerProps) {
  const [jump, setJump] = useState('');
  const [jumpError, setJumpError] = useState<string | null>(null);

  // The cells below are fixed width and do not shrink, so a row that does not fit is a
  // row that runs off the screen. Rather than let that happen, the budget is derived
  // from the width actually available, measured on the pager itself: five numbers need
  // 348px, and a 320px phone would overflow by 28.
  const [container, available] = useWidth();
  const slots = [MAX_PAGES, 4, 3].find((n) => ARROW * 2 + GAP * 2 + NUMBER * n <= available) ?? 3;

  const pages = pageCount(total, limit);
  const current = pageIndex(offset, limit) + 1; // 1-based
  const { from, to } = pageRange(offset, limit, total);

  if (total === 0 || pages <= 1) return null;

  const goTo = (page: number) => onOffsetChange((Math.max(1, Math.min(pages, page)) - 1) * limit);
  const canPrev = current > 1;
  const canNext = current < pages;

  /**
   * Keeps the field from ever holding a page that does not exist.
   *
   * A keystroke that would take the value past the last page is refused rather than
   * accepted and quietly clamped on submit: clamping means typing 999 lands you on
   * page 20 with nothing to say why, which reads as the field ignoring you.
   *
   * Non-digits are stripped because a number pad still offers them on some keyboards,
   * and leading zeros go too, so "007" cannot pass a length check it should not.
   */
  function changeJump(text: string) {
    const digits = text.replace(/[^0-9]/g, '').replace(/^0+/, '');

    if (digits === '') {
      setJump('');
      setJumpError(null);
      return;
    }

    if (Number(digits) > pages) {
      setJumpError(`There ${pages === 1 ? 'is' : 'are'} only ${pages} pages.`);
      return;
    }

    setJump(digits);
    setJumpError(null);
  }

  function submitJump() {
    const page = Number.parseInt(jump, 10);

    // Reachable even though the field is guarded: narrowing a filter can shrink the
    // list under a number that was valid when it was typed.
    if (!Number.isFinite(page) || page < 1 || page > pages) {
      setJumpError(`Enter a page between 1 and ${pages}.`);
      return;
    }

    goTo(page);
    setJump('');
    setJumpError(null);
  }

  return (
    <nav ref={container} aria-label="Pagination" className="flex flex-col items-center gap-2 pt-1">
      <p className="text-muted-foreground text-xs">
        {from}-{to} of {total} {noun}
        {total === 1 ? '' : 's'}
      </p>

      <div className="bg-background flex items-center overflow-hidden rounded-xl border">
        <Arrow
          icon={CaretLeftIcon}
          disabled={!canPrev}
          onClick={() => goTo(current - 1)}
          label="Previous page"
        />

        {pageItems(current, pages, slots).map((item, index) => {
          if (item === 'gap') {
            return (
              <span
                key={`gap-${index}`}
                aria-hidden="true"
                className="text-muted-foreground grid h-9 w-7 place-items-center border-l text-xs">
                ...
              </span>
            );
          }

          const selected = item === current;

          return (
            <button
              key={item}
              type="button"
              aria-current={selected ? 'page' : undefined}
              aria-label={`Page ${item}`}
              onClick={() => goTo(item)}
              className={cn(
                'grid h-9 w-9 cursor-pointer place-items-center border-l text-xs font-medium tabular-nums transition-colors',
                selected ? 'bg-primary text-white' : 'hover:bg-accent'
              )}>
              {item}
            </button>
          );
        })}

        <Arrow
          icon={CaretRightIcon}
          disabled={!canNext}
          onClick={() => goTo(current + 1)}
          label="Next page"
          divided
        />
      </div>

      {pages > MAX_PAGES ? (
        <form
          className="flex flex-col items-center gap-1"
          onSubmit={(event) => {
            event.preventDefault();
            submitJump();
          }}>
          <label className="flex items-center gap-2">
            <span className="text-muted-foreground text-xs">Go to page</span>
            <input
              value={jump}
              onChange={(event) => changeJump(event.target.value)}
              onFocus={onInputFocus}
              inputMode="numeric"
              enterKeyHint="go"
              aria-label="Page number"
              aria-invalid={jumpError ? true : undefined}
              // A second guard behind changeJump, for a paste that arrives whole.
              maxLength={String(pages).length}
              placeholder={`1-${pages}`}
              className={cn(
                'bg-background placeholder:text-muted-foreground h-9 w-20 rounded-md border px-2 text-center text-sm outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50',
                jumpError ? 'border-destructive' : 'border-input'
              )}
            />
            <Button type="submit" size="sm" className="h-9 text-xs" disabled={jump.trim() === ''}>
              <ArrowRightIcon size={14} weight="bold" aria-hidden="true" />
              Go
            </Button>
          </label>

          {jumpError ? (
            <p role="alert" className="text-destructive text-[11px]">
              {jumpError}
            </p>
          ) : null}
        </form>
      ) : null}
    </nav>
  );
}

function Arrow({
  icon: ArrowIcon,
  disabled,
  onClick,
  label,
  divided = false,
}: {
  icon: Icon;
  disabled: boolean;
  onClick: () => void;
  label: string;
  /** Draws the hairline shared with the cell before it. The leading arrow has none. */
  divided?: boolean;
}) {
  return (
    <button
      type="button"
      aria-label={label}
      disabled={disabled}
      onClick={onClick}
      className={cn(
        'text-muted-foreground hover:bg-accent grid h-9 w-10 cursor-pointer place-items-center transition-colors disabled:cursor-default disabled:text-zinc-300 disabled:hover:bg-transparent dark:disabled:text-zinc-700',
        divided && 'border-l'
      )}>
      <ArrowIcon size={15} weight="bold" aria-hidden="true" />
    </button>
  );
}
