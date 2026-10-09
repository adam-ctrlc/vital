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
  disabled?: boolean;
  className?: string;
  'aria-label'?: string;
};

/** A native range input, coloured, with a commit event for saving once per drag. */
export function Slider({
  min,
  max,
  step = 1,
  value,
  onValueChange,
  onValueCommit,
  color,
  disabled = false,
  className,
  ...aria
}: SliderProps) {
  const commit = (target: HTMLInputElement) => onValueCommit?.(Number(target.value));

  return (
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
      className={cn('h-6 w-full cursor-pointer disabled:cursor-not-allowed disabled:opacity-50', className)}
      style={{ accentColor: color } as CSSProperties}
      {...aria}
    />
  );
}
