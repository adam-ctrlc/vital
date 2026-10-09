import { useState } from 'react';

import type { HeatCell } from '@/features/insights/types';
import { formatMinutes, hourLabel, WEEKDAYS_SHORT } from '@/lib/units';
import { cn } from '@/lib/utils';

const STEPS = [0.14, 0.32, 0.5, 0.7, 0.9];
const HOURS = Array.from({ length: 24 }, (_, hour) => hour);

function alpha(opacity: number) {
  return Math.round(opacity * 255)
    .toString(16)
    .padStart(2, '0');
}

/**
 * Average load by weekday and hour, one hue light to dark; a dot marks time over the
 * limit. Hours run down the side on a phone, so the whole day fits without scrolling.
 */
export function Heatmap({ cells, color, dangerColor }: { cells: HeatCell[]; color: string; dangerColor: string }) {
  const byKey = new Map(cells.map((cell) => [`${cell.weekday}-${cell.hour}`, cell]));
  // Shaded by rank rather than against the maximum, so one extreme hour does not wash out
  // the rest.
  const sorted = cells.flatMap((cell) => (cell.avgVa === null ? [] : [cell.avgVa])).sort((a, b) => a - b);
  const step = (va: number) => {
    const rank = sorted.findIndex((value) => value >= va);
    return STEPS[Math.min(STEPS.length - 1, Math.floor((rank / Math.max(sorted.length, 1)) * STEPS.length))];
  };
  const [selected, setSelected] = useState<{ key: string; text: string } | null>(null);

  function square(weekday: number, hour: number, className: string) {
    const key = `${weekday}-${hour}`;
    const cell = byKey.get(key);
    const name = WEEKDAYS_SHORT[weekday];
    const over = cell && cell.overloadMinutes > 0 ? `, ${formatMinutes(cell.overloadMinutes)} over the limit` : '';
    const text = !cell
      ? `${name} ${hourLabel(hour)}: no readings`
      : cell.avgVa === null
        ? `${name} ${hourLabel(hour)}: no load measured${over}`
        : `${name} ${hourLabel(hour)}: average ${cell.avgVa.toFixed(0)} VA, peak ${cell.maxVa?.toFixed(0) ?? cell.avgVa.toFixed(0)} VA${over}`;

    return (
      <button
        type="button"
        key={key}
        title={text}
        aria-label={text}
        onClick={() => setSelected({ key, text })}
        className={cn(
          'bg-muted relative cursor-pointer rounded-[3px] outline-none focus-visible:ring-2 focus-visible:ring-ring',
          selected?.key === key && 'ring-foreground ring-2',
          className
        )}
        style={cell?.avgVa ? { backgroundColor: `${color}${alpha(step(cell.avgVa))}` } : undefined}>
        {cell && cell.overloadMinutes > 0 ? (
          <span
            aria-hidden="true"
            className="absolute right-[2px] top-[2px] size-[5px] rounded-full ring-1 ring-white/80 dark:ring-black/60"
            style={{ backgroundColor: dangerColor }}
          />
        ) : null}
      </button>
    );
  }

  return (
    <div className="space-y-3">
      {/* Phone: hours down, weekdays across. */}
      <div className="grid gap-[2px] text-[10px] sm:hidden" style={{ gridTemplateColumns: '40px repeat(7, 1fr)' }}>
        <span />
        {WEEKDAYS_SHORT.map((name) => (
          <span key={name} className="text-muted-foreground text-center font-medium">
            {name}
          </span>
        ))}
        {HOURS.map((hour) => (
          <div key={hour} className="contents">
            <span className="text-muted-foreground flex items-center tabular-nums">{hour % 3 === 0 ? hourLabel(hour) : ''}</span>
            {WEEKDAYS_SHORT.map((_, weekday) => square(weekday, hour, 'h-4'))}
          </div>
        ))}
      </div>

      {/* Wider: weekdays down, hours across. */}
      <div
        className="hidden gap-[2px] text-[10px] sm:grid"
        style={{ gridTemplateColumns: '32px repeat(24, minmax(0, 1fr))' }}>
        <span />
        {HOURS.map((hour) => (
          <span key={hour} className="text-muted-foreground text-center tabular-nums">
            {hour % 3 === 0 ? hourLabel(hour).replace(' ', '') : ''}
          </span>
        ))}
        {WEEKDAYS_SHORT.map((name, weekday) => (
          <div key={name} className="contents">
            <span className="text-muted-foreground flex items-center font-medium">{name}</span>
            {HOURS.map((hour) => square(weekday, hour, 'aspect-square'))}
          </div>
        ))}
      </div>

      <p className="min-h-4 text-xs font-medium tabular-nums" aria-live="polite">
        {selected?.text ?? <span className="text-muted-foreground font-normal">Tap a square for its numbers.</span>}
      </p>
      <div className="text-muted-foreground flex flex-wrap items-center gap-x-4 gap-y-2 text-xs">
        <span className="flex items-center gap-1.5">
          Lower load
          {STEPS.map((opacity) => (
            <span key={opacity} className="size-3 rounded-[3px]" style={{ backgroundColor: `${color}${alpha(opacity)}` }} />
          ))}
          Higher load
        </span>
        <span className="flex items-center gap-1.5">
          <span className="size-[7px] rounded-full" style={{ backgroundColor: dangerColor }} />
          Time over the limit
        </span>
      </div>
    </div>
  );
}
