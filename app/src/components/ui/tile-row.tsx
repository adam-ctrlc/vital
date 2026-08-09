import type { IconProps } from 'phosphor-react-native';
import type { ComponentType } from 'react';
import { View } from 'react-native';

import { Card, CardContent } from '@/components/ui/card';
import { Text } from '@/components/ui/text';
import { isPlaceholder } from '@/lib/reading-format';
import { cn } from '@/lib/utils';

export type Tile = {
  icon: ComponentType<IconProps>;
  label: string;
  value: string;
  /** Omitted for a bare number. Hidden automatically when the value is a placeholder. */
  unit?: string;
  /** A line under the value saying what it means. Skipped when there is nothing to add. */
  hint?: string;
  iconColor: string;
};

/**
 * A row of measurements sharing one card, divided by hairlines rather than gaps.
 *
 * One card rather than several: separate cards read as separate things, and these are
 * facets of a single reading. The radius belongs to the row, so the dividers can run
 * edge to edge without corners interrupting them.
 */
export function TileRow({ tiles, className }: { tiles: Tile[]; className?: string }) {
  return (
    <Card className={cn('py-0', className)}>
      <CardContent className="flex-row p-0">
        {tiles.map((tile, index) => {
          const Icon = tile.icon;
          // A placeholder is already a whole phrase ("No data"), so a unit beside it
          // would read as a measurement that was actually taken.
          const placeholder = isPlaceholder(tile.value);

          return (
            <View
              key={tile.label}
              className={cn('flex-1 gap-1 p-3', index > 0 && 'border-border border-l')}>
              <View className="flex-row items-center gap-1.5">
                <Icon size={12} weight="bold" color={tile.iconColor} />
                <Text variant="muted" className="text-[10px] uppercase tracking-wide">
                  {tile.label}
                </Text>
              </View>

              <View className="flex-row items-baseline gap-0.5">
                <Text
                  className={cn('text-sm font-bold leading-none', placeholder && 'text-muted-foreground')}>
                  {tile.value}
                </Text>
                {tile.unit && !placeholder ? (
                  <Text variant="muted" className="text-[10px]">
                    {tile.unit}
                  </Text>
                ) : null}
              </View>

              {tile.hint ? (
                <Text variant="muted" className="text-[10px] leading-3">
                  {tile.hint}
                </Text>
              ) : null}
            </View>
          );
        })}
      </CardContent>
    </Card>
  );
}
