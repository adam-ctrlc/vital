import { cn } from '@/lib/utils';
import * as SwitchPrimitives from '@rn-primitives/switch';
import { Platform } from 'react-native';

/**
 * Track and thumb have to be scaled together, and the travel with them: the thumb
 * moves by the track width less its own width and the inset on both sides, so a
 * bigger track alone would leave the thumb stopping short of the end.
 */
const SIZES = {
  default: {
    track: 'h-[1.15rem] w-8',
    thumb: 'size-4',
    travel: 'translate-x-3.5',
  },
  lg: {
    track: 'h-7 w-12',
    thumb: 'size-6',
    travel: 'translate-x-5',
  },
};

function Switch({
  className,
  size = 'default',
  ...props
}: React.ComponentProps<typeof SwitchPrimitives.Root> & { size?: keyof typeof SIZES }) {
  const scale = SIZES[size];

  return (
    <SwitchPrimitives.Root
      className={cn(
        'flex shrink-0 flex-row items-center rounded-full border border-transparent shadow-sm shadow-black/5',
        scale.track,
        Platform.select({
          web: 'focus-visible:border-ring focus-visible:ring-ring/50 peer inline-flex outline-none transition-all focus-visible:ring-[3px] disabled:cursor-not-allowed',
        }),
        props.checked ? 'bg-primary' : 'bg-input dark:bg-input/80',
        props.disabled && 'opacity-50',
        className
      )}
      {...props}>
      <SwitchPrimitives.Thumb
        className={cn(
          'bg-background rounded-full transition-transform',
          scale.thumb,
          Platform.select({
            web: 'pointer-events-none block ring-0',
          }),
          props.checked
            ? `dark:bg-primary-foreground ${scale.travel}`
            : 'dark:bg-foreground translate-x-0'
        )}
      />
    </SwitchPrimitives.Root>
  );
}

export { Switch };
