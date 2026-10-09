import { MoonIcon, SunIcon } from '@phosphor-icons/react';

import { Button } from '@/components/ui/button';
import { useAppearance } from '@/lib/appearance';
import { cn } from '@/lib/utils';

export function ThemeToggle({ className }: { className?: string }) {
  // Through the provider, so this and the Appearance sheet write the same stored value.
  const { theme, setTheme } = useAppearance();
  const isDark = theme === 'dark';

  return (
    <Button
      variant="ghost"
      size="icon"
      className={cn('size-8 rounded-full', className)}
      role="switch"
      aria-checked={isDark}
      aria-label="Dark theme"
      onClick={() => setTheme(isDark ? 'light' : 'dark')}>
      {isDark ? (
        <MoonIcon size={16} weight="fill" aria-hidden="true" />
      ) : (
        <SunIcon size={16} weight="fill" aria-hidden="true" />
      )}
    </Button>
  );
}
