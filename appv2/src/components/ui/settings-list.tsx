import { CaretRightIcon, CheckCircleIcon, type Icon } from '@phosphor-icons/react';
import type { ReactNode } from 'react';

import { Card } from '@/components/ui/card';
import { Skeleton } from '@/components/ui/skeleton';
import { cn } from '@/lib/utils';

/**
 * A titled group of rows, the way a phone's settings app lays things out: a small
 * heading over one card, the rows inside divided by hairlines.
 */
export function SettingsSection({
  title,
  footer,
  footerTone = 'muted',
  children,
}: {
  title: string;
  /** A line under the card: a saved confirmation, an error, a short hint. */
  footer?: string | null;
  footerTone?: 'muted' | 'primary' | 'destructive';
  children: ReactNode;
}) {
  return (
    <section className="space-y-2">
      <h2 className="text-muted-foreground px-1 text-sm font-medium">{title}</h2>
      <Card className="gap-0 divide-y overflow-hidden py-0">{children}</Card>
      {footer ? (
        <p
          className={cn(
            'animate-in fade-in-0 flex items-center gap-1.5 px-1 text-xs',
            footerTone === 'primary' && 'text-primary',
            footerTone === 'destructive' && 'text-destructive',
            footerTone === 'muted' && 'text-muted-foreground'
          )}>
          {footerTone === 'primary' ? <CheckCircleIcon size={14} weight="fill" aria-hidden="true" /> : null}
          {footer}
        </p>
      ) : null}
    </section>
  );
}

type SettingsRowProps = {
  icon?: Icon;
  iconColor?: string;
  label: string;
  /** The current value, shown on the right in muted text. */
  value?: string;
  /** Shows a placeholder bar where the value goes. */
  loading?: boolean;
  /** Anything else on the right, such as a badge or a switch. */
  trailing?: ReactNode;
  /** Makes the whole row a button, with a chevron saying it leads somewhere. */
  onClick?: () => void;
  disabled?: boolean;
};

/** One line in a SettingsSection: icon, label, value, and a chevron when it opens something. */
export function SettingsRow({
  icon: RowIcon,
  iconColor,
  label,
  value,
  loading = false,
  trailing,
  onClick,
  disabled = false,
}: SettingsRowProps) {
  const content = (
    <>
      {RowIcon ? (
        <span className="bg-accent grid size-8 shrink-0 place-items-center rounded-lg">
          <RowIcon size={16} weight="bold" color={iconColor} aria-hidden="true" />
        </span>
      ) : null}
      <span className="shrink-0 grow text-sm font-medium">{label}</span>
      {loading ? (
        <Skeleton className="h-4 w-16" />
      ) : value ? (
        <span className="text-muted-foreground min-w-0 break-words text-right text-sm tabular-nums">{value}</span>
      ) : null}
      {trailing}
      {onClick ? (
        <CaretRightIcon size={14} weight="bold" className="text-muted-foreground" aria-hidden="true" />
      ) : null}
    </>
  );

  const layout = 'flex min-h-[52px] w-full items-center gap-3 px-4 py-2.5';

  if (!onClick) return <div className={layout}>{content}</div>;

  return (
    <button
      type="button"
      disabled={disabled}
      onClick={onClick}
      className={cn(
        layout,
        'cursor-pointer text-left transition-colors hover:bg-accent/60 active:bg-accent disabled:cursor-default disabled:opacity-50'
      )}>
      {content}
    </button>
  );
}
