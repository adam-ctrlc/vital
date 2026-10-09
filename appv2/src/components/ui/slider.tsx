import type { CSSProperties } from 'react';

import { cn } from '@/lib/utils';

type SliderProps = {
  min: number;
  max: number;
  step?: number;
  value: number;
  /** Every step while dragging. */
  onValueChange: (value: number) => void;
  /** Once, when the drag ends or a key press moves it. */
  onValueCommit?: (value: number) => void;
  /** Fill and thumb colour. */
  color: string;
  /** A dot under the track for every position the thumb can land on. */
  marks?: boolean;
  /** Labels the two ends with the minimum and maximum, written this way. */
  formatEnd?: (value: number) => string;
  disabled?: boolean;
  className?: string;
  'aria-label'?: string;
};

/**
 * Where a value sits along the track, as a CSS length. The thumb's centre travels from half
 * a thumb in from each end, not edge to edge, so the fill and the marks use the same inset
 * to stay under it. The thumb size lives in global.css, on .slider-field.
 */
function position(ratio: number) {
  return `calc(var(--slider-thumb) / 2 + (100% - var(--slider-thumb)) * ${ratio})`;
}

/**
 * A native range input with a filled track and a round thumb, styled in global.css. The input
 * is the full 44px row tall, so the thumb is easy to catch with a thumb.
 */
export function Slider({
  min,
  max,
  step = 1,
  value,
  onValueChange,
  onValueCommit,
  color,
  marks = false,
  formatEnd,
  disabled = false,
  className,
  ...aria
}: SliderProps) {
  const commit = (target: HTMLInputElement) => onValueCommit?.(Number(target.value));
  const ratio = max > min ? (value - min) / (max - min) : 0;
  const stops = marks ? Math.round((max - min) / step) + 1 : 0;

  return (
    <div className={cn('slider-field w-full', className)}>
      <div className="relative">
        <input
          type="range"
          min={min}
          max={max}
          step={step}
          value={value}
          disabled={disabled}
          onChange={(event) => onValueChange(Number(event.target.value))}
          onPointerUp={(event) => commit(event.currentTarget)}
          onKeyUp={(event) => {
            if (event.key.startsWith('Arrow') || ['Home', 'End', 'PageUp', 'PageDown'].includes(event.key)) {
              commit(event.currentTarget);
            }
          }}
          className="slider"
          style={{ '--slider-color': color, '--slider-fill': position(ratio) } as CSSProperties}
          {...aria}
        />
        {stops > 1 ? (
          <div className="pointer-events-none absolute inset-x-0 bottom-2 h-1" aria-hidden="true">
            {Array.from({ length: stops }, (_, i) => {
              const at = i / (stops - 1);
              return (
                <span
                  key={i}
                  className={cn('absolute size-1 -translate-x-1/2 rounded-full', at > ratio && 'bg-muted-foreground/40')}
                  style={{ left: position(at), backgroundColor: at <= ratio ? color : undefined }}
                />
              );
            })}
          </div>
        ) : null}
      </div>
      {formatEnd ? (
        <div className="text-muted-foreground mt-0.5 flex justify-between text-xs tabular-nums" aria-hidden="true">
          <span>{formatEnd(min)}</span>
          <span>{formatEnd(max)}</span>
        </div>
      ) : null}
    </div>
  );
}
