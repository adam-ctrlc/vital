import { CheckIcon } from '@phosphor-icons/react';
import { useCallback, useEffect, useState } from 'react';

import { BottomSheet } from '@/components/bottom-sheet';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Spinner } from '@/components/ui/spinner';
import * as deviceApi from '@/features/device/api';
import { usePoll } from '@/hooks/use-poll';
import { useAppearance } from '@/lib/appearance';

const STATUS_MS = 2000;
const SYNCED_HOLD_MS = 1200;

type SourceModeModalProps = {
  visible: boolean;
  token: string | null;
  onSynced: () => void;
  onCancel: () => void;
};

export function SourceModeModal({ visible, token, onSynced, onCancel }: SourceModeModalProps) {
  const { primary } = useAppearance();
  const [synced, setSynced] = useState(false);

  const fetcher = useCallback(
    (signal: AbortSignal) => deviceApi.status(token ?? '', signal),
    [token]
  );
  // Stop polling the moment the board syncs so the success state holds steady.
  const { data } = usePoll(fetcher, STATUS_MS, visible && !synced);

  useEffect(() => {
    if (!visible) setSynced(false);
  }, [visible]);

  useEffect(() => {
    if (visible && data?.connected) setSynced(true);
  }, [visible, data?.connected]);

  useEffect(() => {
    if (!synced) return;
    const id = setTimeout(onSynced, SYNCED_HOLD_MS);
    return () => clearTimeout(id);
  }, [synced, onSynced]);

  return (
    <BottomSheet
      visible={visible}
      title={synced ? 'ESP32 connected' : 'Waiting for ESP32'}
      onClose={onCancel}>
      {synced ? (
        <div className="flex flex-col items-center gap-4 py-6">
          <Badge>
            <CheckIcon size={12} weight="bold" aria-hidden="true" />
            Synced
          </Badge>
          <p className="text-sm font-medium">ESP32 connected</p>
        </div>
      ) : (
        <div className="flex flex-col items-center gap-5 py-6">
          <span style={{ color: primary.hex }}>
            <Spinner className="size-9" label="Waiting for the ESP32" />
          </span>
          <p className="text-muted-foreground text-center text-sm">
            Now on ESP32 mode. The dashboard shows no data until the board reports. You can close
            this and keep waiting.
          </p>
          <Button variant="outline" className="w-full" onClick={onCancel}>
            Close
          </Button>
        </div>
      )}
    </BottomSheet>
  );
}
