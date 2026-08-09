import { useColorScheme } from 'nativewind';
import ArrowRight from 'phosphor-react-native/src/icons/ArrowRight';
import CaretLeft from 'phosphor-react-native/src/icons/CaretLeft';
import CaretRight from 'phosphor-react-native/src/icons/CaretRight';
import { useState } from 'react';
import { Pressable, TextInput, View, useWindowDimensions } from 'react-native';

import { Button } from '@/components/ui/button';
import { Text } from '@/components/ui/text';
import { cn } from '@/lib/utils';
import { MAX_PAGES, pageCount, pageIndex, pageItems, pageRange } from '@/lib/pagination';

/**
 * Cell widths in pixels, matching the classes used below.
 *
 * Kept as numbers because the row has to know whether it fits before it renders, and a
 * class name cannot be measured. They must be changed together with the classes.
 */
const ARROW = 40; // w-10
const NUMBER = 36; // w-9
const GAP = 28; // w-7
/** The `p-4` the screens put around this, which the row does not get to use. */
const SCREEN_PADDING = 32;

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
  const [jumpError, setJumpError] = useState<string | null>(null);

  // The cells below are fixed width and React Native does not shrink flex children by
  // default, so a row that does not fit is a row that runs off the screen. Rather than
  // let that happen, the budget is derived from the width actually available: five
  // numbers need a 348px screen, and a 320px phone would overflow by 28.
  const { width } = useWindowDimensions();
  const available = width - SCREEN_PADDING;
  const slots = [MAX_PAGES, 4, 3].find((n) => ARROW * 2 + GAP * 2 + NUMBER * n <= available) ?? 3;

  const pages = pageCount(total, limit);
  const current = pageIndex(offset, limit) + 1; // 1-based
  const { from, to } = pageRange(offset, limit, total);

  if (total === 0 || pages <= 1) return null;

  const goTo = (page: number) => onOffsetChange((Math.max(1, Math.min(pages, page)) - 1) * limit);
  const canPrev = current > 1;
  const canNext = current < pages;

  /**
   * Keeps the field from ever holding a page that does not exist.
   *
   * A keystroke that would take the value past the last page is refused rather than
   * accepted and quietly clamped on submit: clamping means typing 999 lands you on
   * page 20 with nothing to say why, which reads as the field ignoring you.
   *
   * Non-digits are stripped because a number pad still offers them on some keyboards,
   * and leading zeros go too, so "007" cannot pass a length check it should not.
   */
  function changeJump(text: string) {
    const digits = text.replace(/[^0-9]/g, '').replace(/^0+/, '');

    if (digits === '') {
      setJump('');
      setJumpError(null);
      return;
    }

    if (Number(digits) > pages) {
      setJumpError(`There ${pages === 1 ? 'is' : 'are'} only ${pages} pages.`);
      return;
    }

    setJump(digits);
    setJumpError(null);
  }

  function submitJump() {
    const page = Number.parseInt(jump, 10);

    // Reachable even though the field is guarded: narrowing a filter can shrink the
    // list under a number that was valid when it was typed.
    if (!Number.isFinite(page) || page < 1 || page > pages) {
      setJumpError(`Enter a page between 1 and ${pages}.`);
      return;
    }

    goTo(page);
    setJump('');
    setJumpError(null);
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

        {pageItems(current, pages, slots).map((item, index) => {
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

      {pages > MAX_PAGES ? (
        <View className="items-center gap-1">
          <View className="flex-row items-center gap-2">
            <Text variant="muted" className="text-xs">
              Go to page
            </Text>
            <TextInput
              value={jump}
              onChangeText={changeJump}
              onSubmitEditing={submitJump}
              onFocus={onInputFocus}
              keyboardType="number-pad"
              returnKeyType="go"
              // A second guard behind changeJump, for a paste that arrives whole.
              maxLength={String(pages).length}
              placeholder={`1-${pages}`}
              placeholderTextColor={muted}
              textAlignVertical="center"
              style={{ paddingVertical: 0 }}
              className={cn(
                'bg-background text-foreground h-9 w-20 rounded-md border px-2 text-center text-sm leading-4',
                jumpError ? 'border-destructive' : 'border-input'
              )}
            />
            <Button size="sm" className="h-9" disabled={jump.trim() === ''} onPress={submitJump}>
              <ArrowRight size={14} weight="bold" color="#ffffff" />
              <Text className="text-xs">Go</Text>
            </Button>
          </View>

          {jumpError ? (
            <Text className="text-destructive text-[10px]">{jumpError}</Text>
          ) : null}
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
