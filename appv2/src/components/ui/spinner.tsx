import { cn } from '@/lib/utils';

/** A loading spinner in the current text colour. */
export function Spinner({ className, label = 'Loading' }: { className?: string; label?: string }) {
  return (
    <svg
      role="status"
      aria-label={label}
      viewBox="0 0 24 24"
      fill="none"
      className={cn('size-5 animate-spin', className)}>
      <circle cx="12" cy="12" r="10" stroke="currentColor" strokeOpacity="0.25" strokeWidth="3" />
      <path d="M22 12a10 10 0 0 0-10-10" stroke="currentColor" strokeWidth="3" strokeLinecap="round" />
    </svg>
  );
}
