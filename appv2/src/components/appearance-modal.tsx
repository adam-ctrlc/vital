import { MoonIcon, SunIcon } from '@phosphor-icons/react';
import { memo, useEffect, useState, type ReactNode } from 'react';

import { BottomSheet } from '@/components/bottom-sheet';
import { Button } from '@/components/ui/button';
import { Segmented } from '@/components/ui/segmented';
import {
  AC_COLORS,
  ACCENTS,
  BACKGROUNDS,
  CUSTOM_LABEL,
  MATCH_ACCENT_LABEL,
  PRESETS,
  customColor,
  useAppearance,
  useColorScheme,
  type Preset,
} from '@/lib/appearance';
import { cn } from '@/lib/utils';

const THEMES = [
  { value: 'light' as const, label: 'Light', icon: SunIcon },
  { value: 'dark' as const, label: 'Dark', icon: MoonIcon },
];

// Memoised, and the comparison ignores onClick: a fresh onClick closure every render
// would otherwise defeat memo, and the closure only ever calls a stable setter with a
// fixed item, so the stale one is fine. So a swatch re-renders only when it is
// selected or deselected, not on every appearance change.
const Swatch = memo(
  function Swatch({
    label,
    color,
    selected,
    onClick,
  }: {
    label: string;
    color: string;
    selected: boolean;
    onClick: () => void;
  }) {
    return (
      <button
        type="button"
        aria-pressed={selected}
        aria-label={label}
        title={label}
        onClick={onClick}
        className={cn(
          'cursor-pointer rounded-full border-2 p-0.5 transition-colors',
          selected ? 'border-primary' : 'border-transparent hover:border-border'
        )}>
        <span className="block size-8 rounded-full border border-black/10" style={{ backgroundColor: color }} />
      </button>
    );
  },
  (a, b) => a.color === b.color && a.selected === b.selected && a.label === b.label
);

const PresetChip = memo(
  function PresetChip({
    preset,
    isDark,
    selected,
    onClick,
  }: {
    preset: Preset;
    isDark: boolean;
    selected: boolean;
    onClick: () => void;
  }) {
    const bg = isDark ? preset.background.darkHex : preset.background.lightHex;
    return (
      <button
        type="button"
        aria-pressed={selected}
        onClick={onClick}
        className="flex min-w-0 flex-1 cursor-pointer flex-col gap-1">
        <span
          className={cn(
            'block rounded-[11px] border-2 p-0.5 transition-colors',
            selected ? 'border-primary' : 'border-transparent hover:border-border'
          )}>
          {/* Corner to corner, background through accent to the primary colour: the preset
              read in the order it shows up on screen. */}
          <span
            className="block h-10 w-full overflow-hidden rounded-lg border"
            style={{
              backgroundImage: `linear-gradient(to bottom right, ${bg} 0%, ${preset.accent.hex} 55%, ${preset.primary.hex} 100%)`,
            }}
          />
        </span>
        <span className="text-muted-foreground truncate text-center text-xs">{preset.label}</span>
      </button>
    );
  },
  (a, b) => a.preset === b.preset && a.isDark === b.isDark && a.selected === b.selected
);

function Section({ title, aside, children }: { title: string; aside?: ReactNode; children: ReactNode }) {
  return (
    <section className="space-y-2">
      <div className="flex items-baseline justify-between gap-2">
        <h3 className="text-muted-foreground text-sm font-medium">{title}</h3>
        {aside}
      </div>
      {children}
    </section>
  );
}

/**
 * Any colour: the browser's own colour input, which opens the device's colour chooser,
 * beside the hex code so one can also be typed or pasted.
 */
function CustomColor({ value, selected, onChange }: { value: string; selected: boolean; onChange: (hex: string) => void }) {
  const [text, setText] = useState(value.replace('#', ''));

  // Follows a colour picked any other way, such as a swatch or the native chooser.
  useEffect(() => setText(value.replace('#', '')), [value]);

  return (
    <div className="flex items-center gap-2">
      <span className="text-sm font-medium">Custom</span>
      <input
        type="color"
        aria-label="Pick a custom colour"
        value={value}
        onChange={(event) => onChange(event.target.value)}
        className={cn(
          'ml-auto h-9 w-12 shrink-0 cursor-pointer rounded-md border bg-transparent p-0.5',
          '[&::-webkit-color-swatch-wrapper]:p-0 [&::-webkit-color-swatch]:rounded-[4px] [&::-webkit-color-swatch]:border-0',
          '[&::-moz-color-swatch]:rounded-[4px] [&::-moz-color-swatch]:border-0',
          selected && 'ring-primary ring-2 ring-offset-1 ring-offset-background'
        )}
      />
      <label className="border-input bg-background dark:bg-input/30 flex h-9 w-28 items-center gap-1 rounded-md border px-3 shadow-sm shadow-black/5 focus-within:border-ring focus-within:ring-[3px] focus-within:ring-ring/50">
        <span className="text-muted-foreground text-sm">#</span>
        <input
          aria-label="Hex colour code"
          value={text}
          maxLength={6}
          spellCheck={false}
          autoCapitalize="characters"
          onChange={(event) => {
            const next = event.target.value.replace(/[^0-9a-f]/gi, '');
            setText(next);
            // Applied once it is a whole colour; part-typed codes wait.
            if (next.length === 6) onChange(`#${next.toLowerCase()}`);
          }}
          className="min-w-0 flex-1 bg-transparent font-mono text-sm uppercase outline-none"
        />
      </label>
    </div>
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
      <Section title="Theme">
        <Segmented
          aria-label="Theme"
          options={THEMES}
          value={theme}
          onValueChange={setTheme}
          fill
        />
      </Section>

      <Section title="Presets">
        <div className="flex gap-2">
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
              onClick={() => applyPreset(preset)}
            />
          ))}
        </div>
      </Section>

      <Section
        title="Primary color"
        aside={
          <span className="text-muted-foreground font-mono text-xs uppercase">
            {primary.label === CUSTOM_LABEL ? primary.hex : primary.label}
          </span>
        }>
        <div className="flex flex-wrap gap-1.5">
          {AC_COLORS.map((option) => (
            <Swatch
              key={option.label}
              label={option.label}
              color={option.hex}
              selected={option.label === primary.label}
              onClick={() => setPrimary(option)}
            />
          ))}
        </div>
        {/* Starts from the current colour, so a preset can be nudged rather than rebuilt. */}
        <CustomColor
          value={primary.hex}
          selected={primary.label === CUSTOM_LABEL}
          onChange={(hex) => setPrimary(customColor(hex))}
        />
      </Section>

      <Section title="Accent">
        <div className="flex flex-wrap gap-2.5">
          {ACCENTS.map((option) => (
            <Swatch
              key={option.label}
              label={option.label === MATCH_ACCENT_LABEL ? 'Match the primary color' : option.label}
              // The matching accent previews as a wash of the chosen colour.
              color={option.label === MATCH_ACCENT_LABEL ? `${primary.hex}33` : option.hex}
              selected={option.label === accent.label}
              onClick={() => setAccent(option)}
            />
          ))}
        </div>
      </Section>

      <Section title="Background">
        <div className="flex flex-wrap gap-2.5">
          {BACKGROUNDS.map((option) => (
            <Swatch
              key={option.label}
              label={option.label}
              color={isDark ? option.darkHex : option.lightHex}
              selected={option.label === background.label}
              onClick={() => setBackground(option)}
            />
          ))}
        </div>
      </Section>

      <div className="flex gap-3 pt-1">
        <Button variant="outline" className="flex-1" onClick={reset}>
          Reset
        </Button>
        <Button className="flex-1" onClick={onClose}>
          Done
        </Button>
      </div>
    </BottomSheet>
  );
}
