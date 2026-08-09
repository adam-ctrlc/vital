import { useColorScheme } from 'nativewind';
import Moon from 'phosphor-react-native/src/icons/Moon';
import Sun from 'phosphor-react-native/src/icons/Sun';
import { memo, useState, type ReactNode } from 'react';
import { Pressable, View } from 'react-native';
import Svg, { Defs, LinearGradient, Rect, Stop } from 'react-native-svg';

import { BottomSheet } from '@/components/bottom-sheet';
import { Button } from '@/components/ui/button';
import { Segmented } from '@/components/ui/segmented';
import { Text } from '@/components/ui/text';
import { AC_COLORS, ACCENTS, BACKGROUNDS, PRESETS, useAppearance, type Preset } from '@/lib/appearance';
import { cn } from '@/lib/utils';

const THEMES = [
  { value: 'light' as const, label: 'Light', icon: Sun },
  { value: 'dark' as const, label: 'Dark', icon: Moon },
];

// Memoised, and the comparison ignores onPress: a fresh onPress closure every render
// would otherwise defeat memo, and the closure only ever calls a stable setter with a
// fixed item, so the stale one is fine. So a swatch re-renders only when it is
// selected or deselected, not on every appearance change.
const Swatch = memo(
  function Swatch({
    color,
    selected,
    onPress,
  }: {
    color: string;
    selected: boolean;
    onPress: () => void;
  }) {
    return (
      <Pressable
        onPress={onPress}
        className={cn('rounded-full border-2 p-0.5', selected ? 'border-primary' : 'border-transparent')}>
        <View className="h-8 w-8 rounded-full border border-black/10" style={{ backgroundColor: color }} />
      </Pressable>
    );
  },
  (a, b) => a.color === b.color && a.selected === b.selected
);

const PresetChip = memo(function PresetChip({
  preset,
  isDark,
  selected,
  onPress,
}: {
  preset: Preset;
  isDark: boolean;
  selected: boolean;
  onPress: () => void;
}) {
  const [w, setW] = useState(0);
  const bg = isDark ? preset.background.darkHex : preset.background.lightHex;
  const id = `preset-${preset.label}`;
  return (
    <Pressable onPress={onPress} className="flex-1 gap-1">
      <View
        className={cn(
          'rounded-[11px] border-2 p-0.5',
          selected ? 'border-primary' : 'border-transparent'
        )}>
        <View
          className="h-10 w-full overflow-hidden rounded-lg border border-border"
          onLayout={(e) => setW(e.nativeEvent.layout.width)}>
          {w > 0 ? (
            <Svg width={w} height={40}>
              <Defs>
                <LinearGradient id={id} x1="0" y1="0" x2="1" y2="1">
                  <Stop offset="0" stopColor={bg} />
                  <Stop offset="0.55" stopColor={preset.accent.hex} />
                  <Stop offset="1" stopColor={preset.primary.hex} />
                </LinearGradient>
              </Defs>
              <Rect width={w} height={40} fill={`url(#${id})`} />
            </Svg>
          ) : null}
        </View>
      </View>
      <Text variant="muted" numberOfLines={1} className="text-center text-xs">
        {preset.label}
      </Text>
    </Pressable>
  );
},
(a, b) => a.preset === b.preset && a.isDark === b.isDark && a.selected === b.selected);

function Section({ title, children }: { title: string; children: ReactNode }) {
  return (
    <View className="gap-2">
      <Text variant="muted" className="text-xs uppercase tracking-wide">
        {title}
      </Text>
      <View className="flex-row flex-wrap gap-2.5">{children}</View>
    </View>
  );
}

export function AppearanceModal({ visible, onClose }: { visible: boolean; onClose: () => void }) {
  const { colorScheme } = useColorScheme();
  const isDark = colorScheme === 'dark';
  const {
    primary,
    accent,
    background,
    setPrimary,
    setAccent,
    setBackground,
    applyPreset,
    reset,
    theme,
    setTheme,
  } = useAppearance();

  return (
    <BottomSheet visible={visible} title="Appearance" onClose={onClose}>
      {/* First, because everything below it is drawn differently depending on this:
          the background swatches and the preset previews both switch with the theme. */}
      <View className="gap-2">
        <Text variant="muted" className="text-xs uppercase tracking-wide">
          Theme
        </Text>
        <Segmented
          options={THEMES}
          value={theme}
          onChange={setTheme}
          activeColor={primary.hex}
          inactiveColor={isDark ? '#a1a1aa' : '#71717a'}
          fill
        />
      </View>

      <View className="gap-2">
        <Text variant="muted" className="text-xs uppercase tracking-wide">
          Presets
        </Text>
        <View className="flex-row gap-2">
          {PRESETS.map((preset) => (
            <PresetChip
              key={preset.label}
              preset={preset}
              isDark={isDark}
              selected={
                preset.primary.label === primary.label &&
                preset.accent.label === accent.label &&
                preset.background.label === background.label
              }
              onPress={() => applyPreset(preset)}
            />
          ))}
        </View>
        <Text variant="muted" className="text-xs">
          Default plus recommended palettes. Or fine-tune below.
        </Text>
      </View>

      <Section title="AC color">
        {AC_COLORS.map((option) => (
          <Swatch
            key={option.label}
            color={option.hex}
            selected={option.label === primary.label}
            onPress={() => setPrimary(option)}
          />
        ))}
      </Section>

      <Section title="Accent">
        {ACCENTS.map((option) => (
          <Swatch
            key={option.label}
            color={option.hex}
            selected={option.label === accent.label}
            onPress={() => setAccent(option)}
          />
        ))}
      </Section>

      <Section title="Background">
        {BACKGROUNDS.map((option) => (
          <Swatch
            key={option.label}
            color={isDark ? option.darkHex : option.lightHex}
            selected={option.label === background.label}
            onPress={() => setBackground(option)}
          />
        ))}
      </Section>

      <View className="flex-row gap-3 pt-1">
        <Button variant="outline" className="flex-1" onPress={reset}>
          <Text>Reset</Text>
        </Button>
        <Button className="flex-1" onPress={onClose}>
          <Text>Done</Text>
        </Button>
      </View>
    </BottomSheet>
  );
}
