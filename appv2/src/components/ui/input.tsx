import type { ComponentProps } from 'react';

import { cn } from '@/lib/utils';

function Input({ className, ...props }: ComponentProps<'input'>) {
  return (
    <input
      className={cn(
        'border-input bg-background flex h-10 w-full min-w-0 rounded-md border px-3 py-1 text-base shadow-sm shadow-black/5 outline-none transition-[color,box-shadow] selection:bg-primary selection:text-primary-foreground placeholder:text-muted-foreground focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/50 disabled:pointer-events-none disabled:cursor-not-allowed disabled:opacity-50 aria-invalid:border-destructive sm:h-9 md:text-sm dark:bg-input/30',
        className
      )}
      {...props}
    />
  );
}

export { Input };
