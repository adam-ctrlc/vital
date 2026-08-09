import { useColorScheme } from 'nativewind';
import ArrowRight from 'phosphor-react-native/src/icons/ArrowRight';
import CaretLeft from 'phosphor-react-native/src/icons/CaretLeft';
import CaretRight from 'phosphor-react-native/src/icons/CaretRight';
import { useState } from 'react';
import { Pressable, TextInput, View } from 'react-native';

import { Button } from '@/components/ui/button';
import { Text } from '@/components/ui/text';
import { cn } from '@/lib/utils';
import { pageCount, pageIndex, pageItems, pageRange } from '@/lib/pagination';

type PagerProps = {
  total: number;
  limit: number;
  offset: number;
  onOffsetChange: (offset: number) => void;
  noun?: string;
  /** Called when the jump input is focused, so the screen can scroll it above the keyboard. */
  onInputFocus?: () => void;
};

/**
 * Numbered pagination flanked by icon-only prev/next arrows. Keeps the first and last
 * page plus the current one and its neighbours, eliding the rest with an ellipsis so
 * it stays one compact row.
 *
 * Drawn as a single joined group: one border and one radius around the outside, with
 * the cells divided by hairlines rather than separated by gaps. The radius therefore
 * belongs to the group, not the cells, which is why the arrows are square here and the
 * rounded ends come from the container clipping them.
 */
export function Pager({
  total,
  limit,
  offset,
  onOffsetChange,
  noun = 'record',
  onInputFocus,
}: PagerProps) {
  const { colorScheme } = useColorScheme();
  const muted = colorScheme === 'dark' ? '#a1a1aa' : '#71717a';
  const disabledColor = colorScheme === 'dark' ? '#3f3f46' : '#d4d4d8';

  const [jump, setJump] = useState('');

  const pages = pageCount(total, limit);
  const current = pageIndex(offset, limit) + 1; // 1-based
  const { from, to } = pageRange(offset, limit, total);

  if (total === 0 || pages <= 1) return null;

  const goTo = (page: number) => onOffsetChange((Math.max(1, Math.min(pages, page)) - 1) * limit);
  const canPrev = current > 1;
  const canNext = current < pages;

  function submitJump() {
    const page = Number.parseInt(jump, 10);
    if (Number.isFinite(page)) goTo(page);
    setJump('');
  }

  return (
    <View className="items-center gap-2 pt-1">
      <Text variant="muted" className="text-xs">
        {from}-{to} of {total} {noun}
        {total === 1 ? '' : 's'}
      </Text>

      <View className="border-border bg-background flex-row items-center overflow-hidden rounded-xl border">
        <Arrow
          icon={CaretLeft}
          disabled={!canPrev}
          color={canPrev ? muted : disabledColor}
          onPress={() => goTo(current - 1)}
          label="Previous page"
        />

        {pageItems(current, pages).map((item, index) => {
          if (item === 'gap') {
            return (
              <View
                key={`gap-${index}`}
                className="border-border h-9 w-7 items-center justify-center border-l">
                <Text variant="muted" className="text-xs">
                  ...
                </Text>
              </View>
            );
          }

          const selected = item === current;

          return (
            <Pressable
              key={item}
              accessibilityRole="button"
              accessibilityState={{ selected }}
              onPress={() => goTo(item)}
              className={cn(
                'border-border h-9 w-9 items-center justify-center border-l',
                selected && 'bg-primary'
              )}>
              <Text
                className="text-xs font-medium"
                style={selected ? { color: '#ffffff' } : undefined}>
                {item}
              </Text>
            </Pressable>
          );
        })}

        <Arrow
          icon={CaretRight}
          disabled={!canNext}
          color={canNext ? muted : disabledColor}
          onPress={() => goTo(current + 1)}
          label="Next page"
          divided
        />
      </View>

      {pages > 7 ? (
        <View className="flex-row items-center gap-2">
          <Text variant="muted" className="text-xs">
            Go to page
          </Text>
          <TextInput
            value={jump}
            onChangeText={setJump}
            onSubmitEditing={submitJump}
            onFocus={onInputFocus}
            keyboardType="number-pad"
            returnKeyType="go"
            placeholder={`1-${pages}`}
            placeholderTextColor={muted}
            textAlignVertical="center"
            style={{ paddingVertical: 0 }}
            className="border-input bg-background text-foreground h-9 w-20 rounded-md border px-2 text-center text-sm leading-4"
          />
          <Button size="sm" className="h-9" disabled={jump.trim() === ''} onPress={submitJump}>
            <ArrowRight size={14} weight="bold" color="#ffffff" />
            <Text className="text-xs">Go</Text>
          </Button>
        </View>
      ) : null}
    </View>
  );
}

function Arrow({
  icon: Icon,
  disabled,
  color,
  onPress,
  label,
  divided = false,
}: {
  icon: typeof CaretLeft;
  disabled: boolean;
  color: string;
  onPress: () => void;
  label: string;
  /** Draws the hairline shared with the cell before it. The leading arrow has none. */
  divided?: boolean;
}) {
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={label}
      disabled={disabled}
      onPress={onPress}
      className={cn(
        'h-9 w-10 items-center justify-center',
        divided && 'border-border border-l'
      )}>
      <Icon size={15} weight="bold" color={color} />
    </Pressable>
  );
}
