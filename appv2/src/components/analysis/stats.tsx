import type { ReactNode } from 'react';

import { Card } from '@/components/ui/card';
import { cn } from '@/lib/utils';

export type StatItem = { label: string; value: ReactNode; detail?: ReactNode; tone?: 'danger' | 'warning' };

/** Headline numbers in one card, two across on a phone and four on a wider screen. */
export function Stats({ items }: { items: StatItem[] }) {
  return (
    <Card className="bg-border grid grid-cols-2 gap-px overflow-hidden py-0 sm:grid-cols-4">
      {items.map((item) => (
        <div key={item.label} className="bg-card min-w-0 space-y-1 p-4">
          <p className="text-muted-foreground text-xs">{item.label}</p>
          <p
            className={cn(
              'text-xl font-semibold tabular-nums tracking-tight',
              item.tone === 'danger' && 'text-destructive',
              item.tone === 'warning' && 'text-amber-600 dark:text-amber-400'
            )}>
            {item.value}
          </p>
          {item.detail ? <p className="text-muted-foreground text-xs">{item.detail}</p> : null}
        </div>
      ))}
    </Card>
  );
}

/** A titled card for one chart or table. */
export function Panel({
  title,
  description,
  aside,
  children,
  flush = false,
}: {
  title: string;
  description?: ReactNode;
  aside?: ReactNode;
  children: ReactNode;
  /** Content runs to the card's edges, as a table does. */
  flush?: boolean;
}) {
  return (
    <Card className={cn('gap-3', flush ? 'pb-0 pt-4' : 'p-4')}>
      <div className={cn('flex flex-wrap items-start justify-between gap-x-3 gap-y-1', flush && 'px-4')}>
        <div className="min-w-0">
          <h2 className="text-sm font-semibold">{title}</h2>
          {description ? <p className="text-muted-foreground text-xs">{description}</p> : null}
        </div>
        {aside}
      </div>
      {children}
    </Card>
  );
}
