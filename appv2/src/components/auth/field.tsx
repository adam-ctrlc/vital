import type { ReactNode } from 'react';

/** A labelled form field with an optional hint on the right of the label. */
export function Field({ label, hint, children }: { label: string; hint?: string; children: ReactNode }) {
  return (
    <label className="block min-w-0 space-y-1.5">
      <span className="flex items-baseline justify-between gap-2">
        <span className="text-sm font-medium">{label}</span>
        {hint ? <span className="text-muted-foreground text-[11px]">{hint}</span> : null}
      </span>
      {children}
    </label>
  );
}
