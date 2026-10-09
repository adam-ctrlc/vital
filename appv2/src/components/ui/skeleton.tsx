import type { ComponentProps } from 'react';

import { cn } from '@/lib/utils';

/**
 * Pulses with its own animation rather than `animate-pulse`, which reduced motion turns
 * into a static block that no longer reads as loading.
 */
function Skeleton({ className, ...props }: ComponentProps<'div'>) {
  return <div className={cn('skeleton-pulse bg-accent rounded-md', className)} {...props} />;
}

export { Skeleton };
