import { StatusBar, Style } from '@capacitor/status-bar';
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
  type ReactNode,
} from 'react';

import {
  loadAppearanceLabels,
  loadTheme,
  saveAppearanceLabels,
  saveTheme,
} from '@/lib/appearance-storage';
import { IS_NATIVE } from '@/lib/platform';

type Scheme = 'light' | 'dark';

/**
 * The colour scheme in force, shared outside React so `useColorScheme` works in any
 * component, inside the provider or not, the way NativeWind's hook did.
 *
 * `chosen` is null until someone picks one, which means follow the device.
 */
const systemQuery = window.matchMedia('(prefers-color-scheme: dark)');
let chosen: Scheme | null = null;
const listeners = new Set<() => void>();

function currentScheme(): Scheme {
  return chosen ?? (systemQuery.matches ? 'dark' : 'light');
}

function notify() {
  listeners.forEach((listener) => listener());
}

systemQuery.addEventListener('change', () => {
  if (chosen === null) notify();
});

function setColorScheme(next: Scheme) {
  chosen = next;
  notify();
}

function subscribe(listener: () => void) {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/** Drop-in for NativeWind's `useColorScheme`. */
export function useColorScheme(): { colorScheme: Scheme } {
  return { colorScheme: useSyncExternalStore(subscribe, currentScheme) };
}

export type ColorOption = { label: string; channels: string; hex: string };
export type AccentOption = { label: string; light: string; dark: string; hex: string };
export type BgOption = { label: string; light: string; dark: string; lightHex: string; darkHex: string };

/** `#rrggbb` to the `h s% l%` channels the CSS variables take. */
export function hexToChannels(hex: string): string {
  const [r, g, b] = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255);
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  const l = (max + min) / 2;
  const d = max - min;
  let h = 0;
  let sat = 0;

  if (d !== 0) {
    sat = d / (1 - Math.abs(2 * l - 1));
    if (max === r) h = ((g - b) / d) % 6;
    else if (max === g) h = (b - r) / d + 2;
    else h = (r - g) / d + 4;
    h = Math.round(h * 60);
    if (h < 0) h += 360;
  }

  return `${h} ${Math.round(sat * 100)}% ${Math.round(l * 100)}%`;
}

/** Whether white text on this colour would be hard to read, as on yellow or lime. */
function isLight(hex: string): boolean {
  const [r, g, b] = [1, 3, 5].map((i) => {
    const c = parseInt(hex.slice(i, i + 2), 16) / 255;
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * r + 0.7152 * g + 0.0722 * b > 0.45;
}

export const CUSTOM_LABEL = 'Custom';

export function customColor(hex: string): ColorOption {
  return { label: CUSTOM_LABEL, channels: hexToChannels(hex), hex };
}

const color = (label: string, hex: string): ColorOption => ({ label, hex, channels: hexToChannels(hex) });

// The Tailwind 500 shades, in hue order. The first six names predate the rest and are
// what older installs have stored, so they must keep resolving.
export const AC_COLORS: ColorOption[] = [
  color('Red', '#ef4444'),
  color('Orange', '#f97316'),
  { label: 'Amber', channels: '38 92% 50%', hex: '#f59e0b' },
  color('Yellow', '#eab308'),
  color('Lime', '#84cc16'),
  { label: 'Emerald', channels: '142 71% 45%', hex: '#22c55e' },
  color('Green', '#16a34a'),
  color('Teal', '#14b8a6'),
  { label: 'Cyan', channels: '189 94% 43%', hex: '#06b6d4' },
  color('Sky', '#0ea5e9'),
  { label: 'Blue', channels: '217 91% 60%', hex: '#3b82f6' },
  color('Indigo', '#6366f1'),
  { label: 'Violet', channels: '262 83% 63%', hex: '#8b5cf6' },
  color('Purple', '#a855f7'),
  color('Fuchsia', '#d946ef'),
  color('Pink', '#ec4899'),
  { label: 'Rose', channels: '347 77% 55%', hex: '#f43f5e' },
  color('Slate', '#64748b'),
];

/** The accent that follows the primary colour, so a custom colour gets a matching tint. */
export const MATCH_ACCENT_LABEL = 'Match';

export const ACCENTS: AccentOption[] = [
  // Its values are worked out from the primary colour at the point of use; these are only
  // what the swatch falls back to.
  { label: MATCH_ACCENT_LABEL, light: '217 91% 95%', dark: '217 30% 18%', hex: '#dbeafe' },
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

// By name, not by position: the lists grow, and an index would silently point at
// whatever colour moved into its place.
function pick<T extends { label: string }>(list: T[], label: string): T {
  const found = list.find((option) => option.label === label);
  if (!found) throw new Error(`No appearance option named ${label}`);
  return found;
}

export const DEFAULT_APPEARANCE = {
  primary: pick(AC_COLORS, 'Blue'),
  accent: pick(ACCENTS, 'Blue'),
  background: pick(BACKGROUNDS, 'White'),
};

export const PRESETS: Preset[] = [
  { label: 'Default', ...DEFAULT_APPEARANCE },
  {
    label: 'Ocean',
    recommended: true,
    primary: pick(AC_COLORS, 'Blue'),
    accent: pick(ACCENTS, 'Blue'),
    background: pick(BACKGROUNDS, 'Cool'),
  },
  {
    label: 'Sunset',
    recommended: true,
    primary: pick(AC_COLORS, 'Amber'),
    accent: pick(ACCENTS, 'Warm'),
    background: pick(BACKGROUNDS, 'Warm'),
  },
  {
    label: 'Grape',
    recommended: true,
    primary: pick(AC_COLORS, 'Violet'),
    accent: pick(ACCENTS, 'Neutral'),
    background: pick(BACKGROUNDS, 'Slate'),
  },
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
  const { colorScheme } = useColorScheme();
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
      const custom =
        labels.primary === CUSTOM_LABEL && labels.primaryHex && /^#[0-9a-f]{6}$/i.test(labels.primaryHex)
          ? customColor(labels.primaryHex)
          : null;
      setPrimaryState(
        custom ?? AC_COLORS.find((o) => o.label === labels.primary) ?? DEFAULT_APPEARANCE.primary
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
  }, []);

  /** Persists whichever parts changed, alongside the ones that did not. */
  const persist = useCallback(
    (next: Partial<{ primary: ColorOption; accent: AccentOption; background: BgOption }>) => {
      if (!loaded.current) return;

      const merged = { primary, accent, background, ...next };
      void saveAppearanceLabels({
        primary: merged.primary.label,
        primaryHex: merged.primary.label === CUSTOM_LABEL ? merged.primary.hex : undefined,
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
    (next: Scheme) => {
      setColorScheme(next);
      void saveTheme(next);
    },
    []
  );

  const reset = useCallback(() => {
    setPrimaryState(DEFAULT_APPEARANCE.primary);
    setAccentState(DEFAULT_APPEARANCE.accent);
    setBackgroundState(DEFAULT_APPEARANCE.background);
    persist(DEFAULT_APPEARANCE);
  }, [persist]);

  // Written onto the root element rather than a wrapper, so portals (sheets, toasts)
  // rendered outside the tree pick up the palette too. Layout effect, so the first
  // paint is already in the right colours.
  useLayoutEffect(() => {
    const root = document.documentElement;
    root.classList.toggle('dark', isDark);
    root.style.colorScheme = isDark ? 'dark' : 'light';

    // The matching accent is the primary colour's hue, washed out for light and darkened for dark.
    const [hue, sat] = primary.channels.split(' ');
    const accentChannels =
      accent.label === MATCH_ACCENT_LABEL
        ? isDark
          ? `${hue} ${Math.min(parseInt(sat), 35)}% 18%`
          : `${hue} ${Math.min(parseInt(sat), 90)}% 95%`
        : isDark
          ? accent.dark
          : accent.light;

    const vars: Record<string, string> = {
      '--primary': primary.channels,
      // Dark text on a light primary colour such as yellow, where white would be unreadable.
      '--primary-foreground': isLight(primary.hex) ? '0 0% 9%' : '0 0% 100%',
      '--ring': primary.channels,
      '--accent': accentChannels,
      '--accent-foreground': isDark ? '0 0% 98%' : '0 0% 12%',
      '--background': isDark ? background.dark : background.light,
      '--card': isDark ? background.dark : background.light,
      '--popover': isDark ? background.dark : background.light,
    };
    for (const [name, value] of Object.entries(vars)) root.style.setProperty(name, value);

    const surface = isDark ? background.darkHex : background.lightHex;
    document.querySelector('meta[name="theme-color"]')?.setAttribute('content', surface);

    if (IS_NATIVE) {
      void StatusBar.setStyle({ style: isDark ? Style.Dark : Style.Light }).catch(() => undefined);
    }
  }, [primary.channels, primary.hex, accent.label, accent.dark, accent.light, background, isDark]);

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
    <AppearanceContext.Provider value={value}>{children}</AppearanceContext.Provider>
  );
}
