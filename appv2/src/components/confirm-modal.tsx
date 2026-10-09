import { BottomSheet } from '@/components/bottom-sheet';
import { Button } from '@/components/ui/button';

type ConfirmModalProps = {
  visible: boolean;
  title: string;
  message: string;
  confirmLabel?: string;
  cancelLabel?: string;
  destructive?: boolean;
  busy?: boolean;
  onConfirm: () => void;
  onClose: () => void;
};

/** A yes/no confirmation on the same sheet the rest of the app uses. */
export function ConfirmModal({
  visible,
  title,
  message,
  confirmLabel = 'Confirm',
  cancelLabel = 'Cancel',
  destructive = false,
  busy = false,
  onConfirm,
  onClose,
}: ConfirmModalProps) {
  return (
    <BottomSheet visible={visible} title={title} onClose={onClose}>
      <p className="text-muted-foreground text-sm leading-5">{message}</p>

      <div className="flex gap-2">
        <Button variant="outline" className="flex-1" disabled={busy} onClick={onClose}>
          {cancelLabel}
        </Button>
        <Button
          variant={destructive ? 'destructive' : 'default'}
          className="flex-1"
          disabled={busy}
          onClick={onConfirm}>
          {busy ? 'Working...' : confirmLabel}
        </Button>
      </div>
    </BottomSheet>
  );
}
