import { useAppearance, useColorScheme } from '@/lib/appearance';

export function useChartColors() {
  const { primary } = useAppearance();
  const { colorScheme } = useColorScheme();
  return { primary: primary.hex, danger: colorScheme === 'dark' ? '#f87171' : '#dc2626' };
}
