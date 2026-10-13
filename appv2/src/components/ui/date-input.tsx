import { CalendarBlankIcon, CaretDownIcon } from '@phosphor-icons/react';
import type { ComponentProps } from 'react';

import { cn } from '@/lib/utils';

/**
 * The browser's own date input, so phones open their native picker, with our icons in place
 * of its calendar button. The input fills the field and its button is stretched invisibly
 * over it (see global.css), so a tap anywhere, icons included, opens the picker.
 */
export function DateInput({
  className,
  containerClassName,
  ...props
}: Omit<ComponentProps<'input'>, 'type'> & { containerClassName?: string }) {
  return (
    <div
      className={cn(
        'border-input bg-background dark:bg-input/30 relative h-10 min-w-0 rounded-md border shadow-sm shadow-black/5 transition-[color,box-shadow] focus-within:border-ring focus-within:ring-[3px] focus-within:ring-ring/50 sm:h-9',
        containerClassName
      )}>
      <input
        type="date"
        className={cn('date-input absolute inset-0 size-full rounded-md bg-transparent pl-8 pr-7 text-base outline-none md:text-sm', className)}
        {...props}
      />
      <CalendarBlankIcon
        size={16}
        className="text-muted-foreground pointer-events-none absolute left-2.5 top-1/2 -translate-y-1/2"
        aria-hidden="true"
      />
      <CaretDownIcon
        size={14}
        weight="bold"
        className="text-muted-foreground pointer-events-none absolute right-2.5 top-1/2 -translate-y-1/2"
        aria-hidden="true"
      />
    </div>
  );
}
