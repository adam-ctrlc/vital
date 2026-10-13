import { ImageIcon, TrashIcon } from '@phosphor-icons/react';
import { useEffect, useRef, useState } from 'react';

import { BottomSheet } from '@/components/bottom-sheet';
import { Button } from '@/components/ui/button';
import { Callout } from '@/components/ui/callout';
import { Spinner } from '@/components/ui/spinner';
import { UserAvatar } from '@/components/user-avatar';
import * as authApi from '@/features/auth/api';
import { useAuth } from '@/features/auth/context';
import { compressAvatar } from '@/lib/avatar-image';
import { useAppearance } from '@/lib/appearance';

/** Choose or remove your own photo. It is cropped and compressed on the device before upload. */
export function AvatarSheet({ visible, onClose }: { visible: boolean; onClose: () => void }) {
  const { token, user, setUser } = useAuth();
  const { primary } = useAppearance();
  const input = useRef<HTMLInputElement>(null);
  const [busy, setBusy] = useState<'upload' | 'remove' | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (visible) setError(null);
  }, [visible]);

  async function save(change: () => Promise<Awaited<ReturnType<typeof authApi.removeAvatar>>>, kind: 'upload' | 'remove') {
    setBusy(kind);
    setError(null);
    try {
      setUser(await change());
      onClose();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Could not save the photo.');
    } finally {
      setBusy(null);
      if (input.current) input.current.value = '';
    }
  }

  function choose(file: File) {
    void save(async () => authApi.setAvatar(token ?? '', await compressAvatar(file)), 'upload');
  }

  return (
    <BottomSheet visible={visible} title="Profile picture" onClose={onClose}>
      <div className="flex flex-col items-center gap-4">
        <UserAvatar
          user={user}
          className="size-28 text-3xl font-bold"
          style={{ backgroundColor: `${primary.hex}1f`, color: primary.hex }}
        />
        {error ? <Callout tone="destructive" title={error} className="w-full" /> : null}
        <input
          ref={input}
          type="file"
          accept="image/*"
          className="hidden"
          onChange={(event) => {
            const file = event.target.files?.[0];
            if (file) choose(file);
          }}
        />
        <div className="flex w-full flex-col gap-2">
          <Button disabled={busy !== null} onClick={() => input.current?.click()}>
            {busy === 'upload' ? <Spinner className="size-4" /> : <ImageIcon weight="bold" aria-hidden="true" />}
            {busy === 'upload' ? 'Saving...' : 'Choose a photo'}
          </Button>
          {user?.avatar ? (
            <Button
              variant="outline"
              disabled={busy !== null}
              onClick={() => void save(() => authApi.removeAvatar(token ?? ''), 'remove')}>
              {busy === 'remove' ? <Spinner className="size-4" /> : <TrashIcon weight="bold" aria-hidden="true" />}
              Remove photo
            </Button>
          ) : null}
        </div>
        <p className="text-muted-foreground text-center text-xs">Cropped to a square and shrunk before it is saved.</p>
      </div>
    </BottomSheet>
  );
}
