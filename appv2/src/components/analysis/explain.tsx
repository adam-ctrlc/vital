import { QuestionIcon } from '@phosphor-icons/react';
import { lazy, Suspense, useState } from 'react';

import { BottomSheet } from '@/components/bottom-sheet';
import { Button } from '@/components/ui/button';

const Tex = lazy(() => import('@/components/formula').then((module) => ({ default: module.Tex })));

export type Term = {
  term: string;
  meaning: string;
  /** How it is worked out, as LaTeX. */
  formula?: string;
};

/** A question mark in the page header that opens what the page's terms mean and how each is calculated. */
export function Explain({ title, terms }: { title: string; terms: Term[] }) {
  const [open, setOpen] = useState(false);

  return (
    <>
      <Button
        variant="ghost"
        size="icon"
        className="size-8 rounded-full"
        aria-label={`What ${title} means`}
        onClick={() => setOpen(true)}>
        <QuestionIcon weight="bold" aria-hidden="true" />
      </Button>
      <BottomSheet visible={open} title={title} onClose={() => setOpen(false)}>
        <dl className="divide-y">
          {terms.map(({ term, meaning, formula }) => (
            <div key={term} className="space-y-1 py-3 first:pt-0 last:pb-0">
              <dt className="text-sm font-semibold">{term}</dt>
              <dd className="text-muted-foreground text-sm leading-relaxed">{meaning}</dd>
              {formula ? (
                <dd className="overflow-x-auto pt-1 text-[15px]">
                  <Suspense fallback={<span className="text-muted-foreground text-xs">…</span>}>
                    <Tex latex={formula} />
                  </Suspense>
                </dd>
              ) : null}
            </div>
          ))}
        </dl>
      </BottomSheet>
    </>
  );
}
