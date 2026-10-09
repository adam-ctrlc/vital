import type { Icon } from '@phosphor-icons/react';
import type { ComponentProps } from 'react';

import { cn } from '@/lib/utils';

type IconInputProps = ComponentProps<'input'> & {
  icon: Icon;
  iconColor?: string;
  unit?: string;
  containerClassName?: string;
  /** A button inside the field, after the text, such as show/hide password. */
  action?: {
    icon: Icon;
    label: string;
    onClick: () => void;
  };
};

/**
 * An input with an icon, an optional unit and an optional action. The wrapper owns the
 * fill and the border and the input is transparent, so they never render as two surfaces.
 */
export function IconInput({
  icon: FieldIcon,
  iconColor,
  unit,
  containerClassName,
  action,
  disabled = false,
  className,
  ...props
}: IconInputProps) {
  return (
    <div
      className={cn(
        'border-input bg-background dark:bg-input/30 flex h-10 min-w-0 items-center gap-2 rounded-md border px-3 shadow-sm shadow-black/5 transition-[color,box-shadow] focus-within:border-ring focus-within:ring-[3px] focus-within:ring-ring/50 sm:h-9',
        disabled && 'opacity-60',
        containerClassName
      )}>
      <FieldIcon
        size={16}
        weight="bold"
        color={disabled ? undefined : iconColor}
        className="text-muted-foreground shrink-0"
        aria-hidden="true"
      />
      <input
        disabled={disabled}
        className={cn(
          'placeholder:text-muted-foreground h-full min-w-0 flex-1 bg-transparent text-base outline-none md:text-sm disabled:cursor-not-allowed',
          className
        )}
        {...props}
      />
      {unit ? <span className="text-muted-foreground text-xs font-medium">{unit}</span> : null}
      {action ? (
        <button
          type="button"
          aria-label={action.label}
          className="text-muted-foreground hover:text-foreground -m-2 cursor-pointer p-2"
          onClick={action.onClick}>
          <action.icon size={16} weight="bold" aria-hidden="true" />
        </button>
      ) : null}
    </div>
  );
}
