import Moon from 'phosphor-react-native/src/icons/Moon';
import Sun from 'phosphor-react-native/src/icons/Sun';

import { Button } from '@/components/ui/button';

import { useAppearance } from '@/lib/appearance';
import { cn } from '@/lib/utils';

export function ThemeToggle({ className }: { className?: string }) {
  // Through the provider rather than nativewind directly, so this and the Appearance
  // sheet write the same stored value instead of quietly disagreeing after a restart.
  const { theme, setTheme } = useAppearance();
  const isDark = theme === 'dark';
  const color = isDark ? '#fafafa' : '#0a0a0a';

  return (
    <Button
      variant="ghost"
      size="icon"
      className={cn('h-8 w-8 rounded-full', className)}
      accessibilityRole="switch"
      accessibilityLabel="Toggle light or dark theme"
      onPress={() => setTheme(isDark ? 'light' : 'dark')}>
      {isDark ? (
        <Moon size={16} weight="fill" color={color} />
      ) : (
        <Sun size={16} weight="fill" color={color} />
      )}
    </Button>
  );
}
