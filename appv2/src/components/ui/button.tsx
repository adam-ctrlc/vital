import { cva, type VariantProps } from 'class-variance-authority';
import type { ComponentProps } from 'react';

import { cn } from '@/lib/utils';

const buttonVariants = cva(
  "inline-flex shrink-0 cursor-pointer items-center justify-center gap-2 whitespace-nowrap rounded-md text-sm font-medium outline-none transition-all focus-visible:ring-[3px] focus-visible:ring-ring/50 disabled:pointer-events-none disabled:opacity-50 aria-invalid:border-destructive [&_svg:not([class*='size-'])]:size-4 [&_svg]:pointer-events-none [&_svg]:shrink-0",
  {
    variants: {
      variant: {
        default: 'bg-primary text-primary-foreground shadow-sm shadow-black/5 hover:bg-primary/90',
        destructive:
          'bg-destructive text-white shadow-sm shadow-black/5 hover:bg-destructive/90 focus-visible:ring-destructive/20 dark:bg-destructive/60',
        outline:
          'border bg-background shadow-sm shadow-black/5 hover:bg-accent hover:text-accent-foreground dark:border-input dark:bg-input/30 dark:hover:bg-input/50',
        secondary: 'bg-secondary text-secondary-foreground shadow-sm shadow-black/5 hover:bg-secondary/80',
        ghost: 'hover:bg-accent hover:text-accent-foreground dark:hover:bg-accent/50',
        link: 'text-primary underline-offset-4 hover:underline',
      },
      size: {
        default: 'h-10 px-4 py-2 has-[>svg]:px-3 sm:h-9',
        sm: 'h-9 gap-1.5 px-3 has-[>svg]:px-2.5 sm:h-8',
        lg: 'h-11 px-6 has-[>svg]:px-4 sm:h-10',
        icon: 'size-10 sm:size-9',
      },
    },
    defaultVariants: {
      variant: 'default',
      size: 'default',
    },
  }
);

type ButtonProps = ComponentProps<'button'> & VariantProps<typeof buttonVariants>;

function Button({ className, variant, size, type = 'button', ...props }: ButtonProps) {
  return <button type={type} className={cn(buttonVariants({ variant, size }), className)} {...props} />;
}

export { Button, buttonVariants };
export type { ButtonProps };
