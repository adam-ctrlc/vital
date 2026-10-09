import type { Icon } from '@phosphor-icons/react';

import { Card } from '@/components/ui/card';
import { isPlaceholder } from '@/lib/reading-format';
import { cn } from '@/lib/utils';

export type Tile = {
  icon: Icon;
  label: string;
  value: string;
  /** Omitted for a bare number. Hidden automatically when the value is a placeholder. */
  unit?: string;
  /** A line under the value saying what it means. */
  hint?: string;
  iconColor: string;
};

/**
 * A row of measurements sharing one card, divided by hairlines rather than gaps: they
 * are facets of a single reading, not separate things.
 */
export function TileRow({ tiles, className }: { tiles: Tile[]; className?: string }) {
  return (
    <Card className={cn('flex-row gap-0 divide-x py-0', className)}>
      {tiles.map((tile) => {
        const TileIcon = tile.icon;
        // A placeholder is already a whole phrase ("No data"), so a unit beside it would
        // read as a measurement that was actually taken.
        const placeholder = isPlaceholder(tile.value);

        return (
          <div key={tile.label} className="flex min-w-0 flex-1 flex-col gap-1 p-3">
            <div className="flex items-center gap-1.5">
              <TileIcon size={12} weight="bold" color={tile.iconColor} aria-hidden="true" />
              <span className="text-muted-foreground text-[10px] uppercase tracking-wide">{tile.label}</span>
            </div>
            <p className="flex items-baseline gap-0.5">
              <span className={cn('text-sm font-bold leading-none', placeholder && 'text-muted-foreground')}>
                {tile.value}
              </span>
              {tile.unit && !placeholder ? (
                <span className="text-muted-foreground text-[10px]">{tile.unit}</span>
              ) : null}
            </p>
            {tile.hint ? <p className="text-muted-foreground text-[10px] leading-3">{tile.hint}</p> : null}
          </div>
        );
      })}
    </Card>
  );
}
