import { CheckIcon, type Icon } from '@phosphor-icons/react';
import { useEffect, useState } from 'react';

import { BottomSheet } from '@/components/bottom-sheet';
import { Button } from '@/components/ui/button';
import { Callout } from '@/components/ui/callout';
import { IconInput } from '@/components/ui/icon-input';

/** Edits one number, such as the electricity rate. */
export function NumberSheet({
  visible,
  title,
  label,
  icon,
  iconColor,
  unit,
  value,
  min,
  max,
  onSave,
  onClose,
}: {
  visible: boolean;
  title: string;
  label: string;
  icon: Icon;
  iconColor: string;
  unit: string;
  value: number;
  min: number;
  max: number;
  onSave: (value: number) => Promise<void>;
  onClose: () => void;
}) {
  const [text, setText] = useState(String(value));
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!visible) return;
    setText(String(value));
    setError(null);
  }, [visible, value]);

  const number = Number(text);
  const valid = text.trim() !== '' && Number.isFinite(number) && number >= min && number <= max;

  return (
    <BottomSheet visible={visible} title={title} onClose={onClose}>
      <form
        className="flex flex-col gap-4"
        onSubmit={async (event) => {
          event.preventDefault();
          if (!valid) return;
          setSaving(true);
          try {
            await onSave(number);
            onClose();
          } catch (caught) {
            setError((caught as Error).message);
          } finally {
            setSaving(false);
          }
        }}>
        <label className="space-y-1.5">
          <span className="text-sm font-medium">{label}</span>
          <IconInput
            icon={icon}
            iconColor={iconColor}
            unit={unit}
            inputMode="decimal"
            value={text}
            onChange={(event) => setText(event.target.value)}
            autoFocus
          />
          <span className="text-muted-foreground block text-xs">
            Between {min} and {max}.
          </span>
        </label>
        {error ? <Callout tone="destructive" title="Could not save" description={error} /> : null}
        <Button type="submit" disabled={!valid || saving}>
          <CheckIcon weight="bold" aria-hidden="true" />
          {saving ? 'Saving…' : 'Save'}
        </Button>
      </form>
    </BottomSheet>
  );
}
