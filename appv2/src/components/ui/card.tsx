import type { ComponentProps } from 'react';

import { cn } from '@/lib/utils';

/** `card` is the hook global.css uses to run cards edge to edge on a phone. */
function Card({ className, ...props }: ComponentProps<'div'>) {
  return (
    <div
      className={cn(
        'card bg-card text-card-foreground flex flex-col gap-6 rounded-xl border py-6 shadow-sm shadow-black/5',
        className
      )}
      {...props}
    />
  );
}

function CardHeader({ className, ...props }: ComponentProps<'div'>) {
  return <div className={cn('flex flex-col gap-1.5 px-6', className)} {...props} />;
}

function CardTitle({ className, ...props }: ComponentProps<'h3'>) {
  return <h3 className={cn('font-semibold leading-none', className)} {...props} />;
}

function CardDescription({ className, ...props }: ComponentProps<'p'>) {
  return <p className={cn('text-muted-foreground text-sm', className)} {...props} />;
}

function CardContent({ className, ...props }: ComponentProps<'div'>) {
  return <div className={cn('px-6', className)} {...props} />;
}

function CardFooter({ className, ...props }: ComponentProps<'div'>) {
  return <div className={cn('flex items-center px-6', className)} {...props} />;
}

export { Card, CardContent, CardDescription, CardFooter, CardHeader, CardTitle };
