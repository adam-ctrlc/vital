import { useColorScheme, vars } from 'nativewind';
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from 'react';
import { View } from 'react-native';

import {
  loadAppearanceLabels,
  loadTheme,
  saveAppearanceLabels,
  saveTheme,
} from '@/lib/appearance-storage';

export type ColorOption = { label: string; channels: string; hex: string };
export type AccentOption = { label: string; light: string; dark: string; hex: string };
export type BgOption = { label: string; light: string; dark: string; lightHex: string; darkHex: string };

export const AC_COLORS: ColorOption[] = [
  { label: 'Emerald', channels: '142 71% 45%', hex: '#22c55e' },
  { label: 'Blue', channels: '217 91% 60%', hex: '#3b82f6' },
  { label: 'Violet', channels: '262 83% 63%', hex: '#8b5cf6' },
  { label: 'Cyan', channels: '189 94% 43%', hex: '#06b6d4' },
  { label: 'Amber', channels: '38 92% 50%', hex: '#f59e0b' },
  { label: 'Rose', channels: '347 77% 55%', hex: '#f43f5e' },
];

export const ACCENTS: AccentOption[] = [
  { label: 'Green', light: '140 60% 95%', dark: '142 30% 16%', hex: '#dcfce7' },
  { label: 'Neutral', light: '0 0% 96%', dark: '0 0% 15%', hex: '#e4e4e7' },
  { label: 'Blue', light: '214 95% 95%', dark: '217 33% 20%', hex: '#dbeafe' },
  { label: 'Warm', light: '38 92% 94%', dark: '30 40% 18%', hex: '#fef3c7' },
];

export const BACKGROUNDS: BgOption[] = [
  { label: 'White', light: '0 0% 100%', dark: '0 0% 3.9%', lightHex: '#ffffff', darkHex: '#0a0a0a' },
  { label: 'Slate', light: '210 40% 99%', dark: '222 47% 8%', lightHex: '#f8fafc', darkHex: '#0b1120' },
  { label: 'Warm', light: '40 33% 99%', dark: '20 14% 8%', lightHex: '#fffdf7', darkHex: '#171311' },
  { label: 'Cool', light: '200 33% 99%', dark: '215 32% 9%', lightHex: '#f6fbfe', darkHex: '#0c141b' },
];

export type Preset = {
  label: string;
  recommended?: boolean;
  primary: ColorOption;
  accent: AccentOption;
  background: BgOption;
};

export const DEFAULT_APPEARANCE = {
  primary: AC_COLORS[1],
  accent: ACCENTS[2],
  background: BACKGROUNDS[0],
};

export const PRESETS: Preset[] = [
  { label: 'Default', primary: AC_COLORS[1], accent: ACCENTS[2], background: BACKGROUNDS[0] },
  { label: 'Ocean', recommended: true, primary: AC_COLORS[1], accent: ACCENTS[2], background: BACKGROUNDS[3] },
  { label: 'Sunset', recommended: true, primary: AC_COLORS[4], accent: ACCENTS[3], background: BACKGROUNDS[2] },
  { label: 'Grape', recommended: true, primary: AC_COLORS[2], accent: ACCENTS[1], background: BACKGROUNDS[1] },
];

type AppearanceValue = {
  primary: ColorOption;
  accent: AccentOption;
  background: BgOption;
  setPrimary: (option: ColorOption) => void;
  setAccent: (option: AccentOption) => void;
  setBackground: (option: BgOption) => void;
  applyPreset: (preset: Preset) => void;
  reset: () => void;
  /** Light or dark. Kept here so choosing one persists, like the palette does. */
  theme: 'light' | 'dark';
  setTheme: (theme: 'light' | 'dark') => void;
};

const AppearanceContext = createContext<AppearanceValue | null>(null);

export function useAppearance() {
  const ctx = useContext(AppearanceContext);
  if (!ctx) throw new Error('useAppearance must be used within an AppearanceProvider');
  return ctx;
}

export function AppearanceProvider({ children }: { children: ReactNode }) {
  const { colorScheme, setColorScheme } = useColorScheme();
  const isDark = colorScheme === 'dark';
  const [primary, setPrimaryState] = useState<ColorOption>(DEFAULT_APPEARANCE.primary);
  const [accent, setAccentState] = useState<AccentOption>(DEFAULT_APPEARANCE.accent);
  const [background, setBackgroundState] = useState<BgOption>(DEFAULT_APPEARANCE.background);

  /**
   * False until the stored palette has been read.
   *
   * Every setter writes as it goes, and the load below is itself a set. Without this
   * the very first render would save the defaults over whatever was stored, so the
   * palette would reset on every launch while looking like it was being saved.
   */
  const loaded = useRef(false);

  useEffect(() => {
    let active = true;

    // Resolved here rather than in the store, because this is where the palette lives.
    // An unknown label falls back to the default, so removing an option cannot leave a
    // phone stuck on a color that no longer exists.
    void loadAppearanceLabels().then((labels) => {
      if (!active) return;
      setPrimaryState(
        AC_COLORS.find((o) => o.label === labels.primary) ?? DEFAULT_APPEARANCE.primary
      );
      setAccentState(ACCENTS.find((o) => o.label === labels.accent) ?? DEFAULT_APPEARANCE.accent);
      setBackgroundState(
        BACKGROUNDS.find((o) => o.label === labels.background) ?? DEFAULT_APPEARANCE.background
      );
      loaded.current = true;
    });

    // Left alone when nothing is stored, so a fresh install keeps following the phone
    // rather than being pinned to a theme nobody picked.
    void loadTheme().then((stored) => {
      if (active && stored) setColorScheme(stored);
    });

    return () => {
      active = false;
    };
  }, [setColorScheme]);

  /** Persists whichever parts changed, alongside the ones that did not. */
  const persist = useCallback(
    (next: Partial<{ primary: ColorOption; accent: AccentOption; background: BgOption }>) => {
      if (!loaded.current) return;

      const merged = { primary, accent, background, ...next };
      void saveAppearanceLabels({
        primary: merged.primary.label,
        accent: merged.accent.label,
        background: merged.background.label,
      });
    },
    [primary, accent, background]
  );

  const setPrimary = useCallback(
    (option: ColorOption) => {
      setPrimaryState(option);
      persist({ primary: option });
    },
    [persist]
  );

  const setAccent = useCallback(
    (option: AccentOption) => {
      setAccentState(option);
      persist({ accent: option });
    },
    [persist]
  );

  const setBackground = useCallback(
    (option: BgOption) => {
      setBackgroundState(option);
      persist({ background: option });
    },
    [persist]
  );

  const applyPreset = useCallback(
    (preset: Preset) => {
      setPrimaryState(preset.primary);
      setAccentState(preset.accent);
      setBackgroundState(preset.background);
      persist(preset);
    },
    [persist]
  );

  const setTheme = useCallback(
    (next: 'light' | 'dark') => {
      setColorScheme(next);
      void saveTheme(next);
    },
    [setColorScheme]
  );

  const reset = useCallback(() => {
    setPrimaryState(DEFAULT_APPEARANCE.primary);
    setAccentState(DEFAULT_APPEARANCE.accent);
    setBackgroundState(DEFAULT_APPEARANCE.background);
    persist(DEFAULT_APPEARANCE);
  }, [persist]);

  // A fresh vars() object on every render re-applies the whole variable set to the
  // subtree, so it is rebuilt only when a value it depends on actually changes.
  const style = useMemo(
    () =>
      vars({
        '--primary': primary.channels,
        '--primary-foreground': '0 0% 100%',
        '--ring': primary.channels,
        '--accent': isDark ? accent.dark : accent.light,
        '--accent-foreground': isDark ? '0 0% 98%' : '0 0% 12%',
        '--background': isDark ? background.dark : background.light,
        '--card': isDark ? background.dark : background.light,
        '--popover': isDark ? background.dark : background.light,
      }),
    [primary.channels, accent.dark, accent.light, background.dark, background.light, isDark]
  );

  const value = useMemo<AppearanceValue>(
    () => ({
      primary,
      accent,
      background,
      setPrimary,
      setAccent,
      setBackground,
      applyPreset,
      reset,
      theme: isDark ? ('dark' as const) : ('light' as const),
      setTheme,
    }),
    [
      primary,
      accent,
      background,
      setPrimary,
      setAccent,
      setBackground,
      applyPreset,
      reset,
      isDark,
      setTheme,
    ]
  );

  return (
    <AppearanceContext.Provider value={value}>
      <View style={style} className="flex-1">
        {children}
      </View>
    </AppearanceContext.Provider>
  );
}
