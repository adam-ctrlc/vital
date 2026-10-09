import type { Icon } from '@phosphor-icons/react';

import { cn } from '@/lib/utils';

type SegmentedOption<T> = {
  label: string;
  value: T;
  icon?: Icon;
  disabled?: boolean;
};

type SegmentedProps<T> = {
  options: SegmentedOption<T>[];
  value: T;
  onValueChange: (value: T) => void;
  className?: string;
  /** Stretch each option to share the width equally, rather than hugging its label. */
  fill?: boolean;
  /** 'sm' for a choice inline in a row or a header; 'default' matches inputs and buttons. */
  size?: 'default' | 'sm';
  'aria-label'?: string;
};

/**
 * A set of mutually exclusive options, all visible at once: a muted track with the chosen
 * option raised on it. One look everywhere, sized to sit level with inputs and buttons.
 */
export function Segmented<T extends string | number | boolean | null>({
  options,
  value,
  onValueChange,
  className,
  fill = false,
  size = 'default',
  ...aria
}: SegmentedProps<T>) {
  return (
    <div
      role="radiogroup"
      className={cn(
        'bg-muted text-muted-foreground inline-flex shrink-0 items-center rounded-lg p-[3px]',
        size === 'sm' ? 'h-8' : 'h-10 sm:h-9',
        fill && 'flex w-full',
        className
      )}
      {...aria}>
      {options.map((option) => {
        const selected = option.value === value;
        const OptionIcon = option.icon;

        return (
          <button
            key={option.label}
            type="button"
            role="radio"
            aria-checked={selected}
            disabled={option.disabled}
            onClick={() => onValueChange(option.value)}
            className={cn(
              'inline-flex h-full cursor-pointer items-center justify-center gap-1.5 whitespace-nowrap rounded-md font-medium outline-none transition-all focus-visible:ring-[3px] focus-visible:ring-ring/50 disabled:cursor-not-allowed disabled:opacity-50',
              size === 'sm' ? 'px-2.5 text-xs' : 'px-3 text-sm',
              fill && 'flex-1',
              selected
                ? 'bg-background text-foreground shadow-sm shadow-black/10 dark:bg-input/60'
                : 'hover:text-foreground'
            )}>
            {OptionIcon ? <OptionIcon size={size === 'sm' ? 13 : 15} weight="bold" aria-hidden="true" /> : null}
            {option.label}
          </button>
        );
      })}
    </div>
  );
}
