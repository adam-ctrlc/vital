import { XIcon } from '@phosphor-icons/react';
import { useEffect, useId, type ReactNode } from 'react';
import { createPortal } from 'react-dom';

import { Button } from '@/components/ui/button';

type BottomSheetProps = {
  visible: boolean;
  title: string;
  onClose: () => void;
  children: ReactNode;
};

/**
 * The app's modal surface: a sheet from the bottom on a phone, a centred dialog on a
 * wider screen. Sized in dynamic viewport units, so the on-screen keyboard shrinks the
 * space it has rather than covering the fields.
 */
export function BottomSheet({ visible, title, onClose, children }: BottomSheetProps) {
  const titleId = useId();

  useEffect(() => {
    if (!visible) return;

    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose();
    };
    // The page behind scrolls with the document, so it is held still while this is up.
    const previous = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    window.addEventListener('keydown', onKey);

    return () => {
      window.removeEventListener('keydown', onKey);
      document.body.style.overflow = previous;
    };
  }, [visible, onClose]);

  // Unmounted while hidden, so its contents are not live behind every page.
  if (!visible) return null;

  return createPortal(
    <div
      className="fixed inset-0 z-50 flex flex-col justify-end sm:items-center sm:justify-center sm:p-6"
      role="dialog"
      aria-modal="true"
      aria-labelledby={titleId}>
      <div className="animate-in fade-in-0 absolute inset-0 bg-black/50 duration-200" onClick={onClose} />
      <div className="animate-in slide-in-from-bottom sm:zoom-in-95 sm:slide-in-from-bottom-4 bg-card relative flex max-h-[90dvh] w-full flex-col overflow-hidden rounded-t-3xl border duration-300 sm:max-w-lg sm:rounded-3xl">
        <div className="flex items-center justify-between px-5 pb-2 pt-5">
          <h2 id={titleId} className="text-lg font-semibold">
            {title}
          </h2>
          <Button variant="ghost" size="icon" aria-label="Close" onClick={onClose}>
            <XIcon size={20} weight="bold" aria-hidden="true" />
          </Button>
        </div>
        <div className="flex shrink flex-col gap-5 overflow-y-auto overscroll-contain px-5 pb-[calc(env(safe-area-inset-bottom)+32px)] pt-1">
          {children}
        </div>
      </div>
    </div>,
    document.body
  );
}
