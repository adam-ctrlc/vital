import { CheckCircleIcon, InfoIcon, WarningCircleIcon, type Icon } from '@phosphor-icons/react';
import type { ReactNode } from 'react';

import { cn } from '@/lib/utils';

export type CalloutTone = 'info' | 'success' | 'warning' | 'destructive';

const TONES: Record<CalloutTone, { box: string; icon: Icon; dot: string }> = {
  info: { box: 'bg-primary/10 text-primary', icon: InfoIcon, dot: 'bg-primary' },
  success: {
    box: 'bg-emerald-500/10 text-emerald-700 dark:text-emerald-400',
    icon: CheckCircleIcon,
    dot: 'bg-emerald-500',
  },
  warning: {
    box: 'bg-amber-500/10 text-amber-700 dark:text-amber-400',
    icon: WarningCircleIcon,
    dot: 'bg-amber-500',
  },
  destructive: { box: 'bg-destructive/10 text-destructive', icon: WarningCircleIcon, dot: 'bg-destructive' },
};

/**
 * A tinted status line: an icon (or a live dot), a title and an optional line under it.
 * For state the page is in right now, such as waiting on the board, rather than for
 * explanations.
 */
export function Callout({
  tone,
  title,
  description,
  live = false,
  className,
}: {
  tone: CalloutTone;
  title: string;
  description?: ReactNode;
  /** A pulsing dot instead of the icon, for something still in progress. */
  live?: boolean;
  className?: string;
}) {
  const { box, icon: ToneIcon, dot } = TONES[tone];

  return (
    <div
      role={tone === 'destructive' ? 'alert' : 'status'}
      className={cn('animate-in fade-in-0 flex items-start gap-3 rounded-lg px-3 py-2.5', box, className)}>
      {live ? (
        <span className="relative mt-1.5 flex size-2.5 shrink-0" aria-hidden="true">
          <span className={cn('absolute inline-flex size-full animate-ping rounded-full opacity-60', dot)} />
          <span className={cn('relative inline-flex size-2.5 rounded-full', dot)} />
        </span>
      ) : (
        <ToneIcon size={18} weight="fill" className="mt-px shrink-0" aria-hidden="true" />
      )}
      <div className="min-w-0 flex-1">
        <p className="text-sm font-semibold">{title}</p>
        {description ? <div className="text-xs opacity-80">{description}</div> : null}
      </div>
    </div>
  );
}
