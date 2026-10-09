import type { Icon } from '@phosphor-icons/react';

import { Card } from '@/components/ui/card';

/** A no-data placeholder: a large, faint icon over a title and a line of guidance. */
export function EmptyState({
  icon: StateIcon,
  title,
  description,
}: {
  icon: Icon;
  title: string;
  description: string;
}) {
  return (
    <Card className="items-center gap-3 p-8 text-center">
      <StateIcon size={72} weight="duotone" className="text-zinc-300 dark:text-zinc-600" aria-hidden="true" />
      <div className="space-y-1">
        <p className="font-semibold">{title}</p>
        <p className="text-muted-foreground text-sm">{description}</p>
      </div>
    </Card>
  );
}
