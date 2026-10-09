import { cn } from '@/lib/utils';

/** Track, thumb and travel are scaled together, or the thumb stops short of the end. */
const SIZES = {
  default: { track: 'h-[1.15rem] w-8', thumb: 'size-4', travel: 'translate-x-3.5' },
  lg: { track: 'h-7 w-12', thumb: 'size-6', travel: 'translate-x-5' },
};

type SwitchProps = {
  checked: boolean;
  onCheckedChange: (checked: boolean) => void;
  disabled?: boolean;
  size?: keyof typeof SIZES;
  className?: string;
  'aria-label'?: string;
};

function Switch({ checked, onCheckedChange, disabled, size = 'default', className, ...aria }: SwitchProps) {
  const scale = SIZES[size];

  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      disabled={disabled}
      onClick={() => onCheckedChange(!checked)}
      className={cn(
        'inline-flex shrink-0 cursor-pointer items-center rounded-full border border-transparent shadow-sm shadow-black/5 outline-none transition-all focus-visible:ring-[3px] focus-visible:ring-ring/50 disabled:cursor-not-allowed disabled:opacity-50',
        scale.track,
        checked ? 'bg-primary' : 'bg-input dark:bg-input/80',
        className
      )}
      {...aria}>
      <span
        className={cn(
          'bg-background pointer-events-none block rounded-full transition-transform',
          scale.thumb,
          checked ? `dark:bg-primary-foreground ${scale.travel}` : 'dark:bg-foreground translate-x-0'
        )}
      />
    </button>
  );
}

export { Switch };
