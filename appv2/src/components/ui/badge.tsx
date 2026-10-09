import { cva, type VariantProps } from 'class-variance-authority';
import type { ComponentProps } from 'react';

import { cn } from '@/lib/utils';

const badgeVariants = cva(
  // One size everywhere: a status reads the same on every page, so callers do not resize it.
  'inline-flex h-5 w-fit shrink-0 items-center justify-center gap-1 overflow-hidden whitespace-nowrap rounded-full border px-2 text-[11px] font-semibold uppercase tracking-wide [&>svg]:pointer-events-none [&>svg]:size-3',
  {
    variants: {
      variant: {
        default: 'bg-primary text-primary-foreground border-transparent',
        secondary: 'bg-secondary text-secondary-foreground border-transparent',
        destructive: 'bg-destructive border-transparent text-white',
        outline: 'text-foreground',
      },
    },
    defaultVariants: {
      variant: 'default',
    },
  }
);

type BadgeProps = ComponentProps<'span'> & VariantProps<typeof badgeVariants>;

function Badge({ className, variant, ...props }: BadgeProps) {
  return <span className={cn(badgeVariants({ variant }), className)} {...props} />;
}

export { Badge, badgeVariants };
export type { BadgeProps };
