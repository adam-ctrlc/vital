import {
  AtIcon,
  CheckIcon,
  EnvelopeIcon,
  EyeIcon,
  EyeSlashIcon,
  IdentificationCardIcon,
  LockIcon,
} from '@phosphor-icons/react';
import { useEffect, useState, type ReactNode } from 'react';

import { BottomSheet } from '@/components/bottom-sheet';
import { Button } from '@/components/ui/button';
import { Callout } from '@/components/ui/callout';
import { IconInput } from '@/components/ui/icon-input';
import * as authApi from '@/features/auth/api';
import { useAuth } from '@/features/auth/context';
import type { User } from '@/features/auth/types';
import { useAppearance } from '@/lib/appearance';

const MIN_PASSWORD = 8;

function Field({ label, hint, children }: { label: string; hint?: string; children: ReactNode }) {
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

/** Cancel and Save for a sheet form; Save submits the form, so Enter saves too. */
function FormActions({
  busy,
  canSave,
  saveLabel,
  onCancel,
}: {
  busy: boolean;
  canSave: boolean;
  saveLabel: string;
  onCancel: () => void;
}) {
  return (
    <div className="flex gap-2">
      <Button variant="outline" className="flex-1" disabled={busy} onClick={onCancel}>
        Cancel
      </Button>
      <Button type="submit" className="flex-1" disabled={busy || !canSave}>
        <CheckIcon weight="bold" aria-hidden="true" />
        {busy ? 'Saving...' : saveLabel}
      </Button>
    </div>
  );
}

type Draft = { firstName: string; middleName: string; lastName: string; email: string; username: string };

function draftOf(user: User | null): Draft {
  return {
    firstName: user?.firstName ?? '',
    middleName: user?.middleName ?? '',
    lastName: user?.lastName ?? '',
    email: user?.email ?? '',
    username: user?.username ?? '',
  };
}

/**
 * Name, and for an admin the sign-in identity. A user's email and username are set by an
 * admin, so for them those fields are not offered at all rather than shown greyed out.
 */
export function EditProfileSheet({
  visible,
  onClose,
  onSaved,
}: {
  visible: boolean;
  onClose: () => void;
  onSaved: () => void;
}) {
  const { token, user, setUser } = useAuth();
  const { primary } = useAppearance();
  const isAdmin = user?.role === 'admin';

  const [draft, setDraft] = useState<Draft>(draftOf(user));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Starts from what is saved each time it opens, so a cancelled edit does not linger.
  useEffect(() => {
    if (!visible) return;
    setDraft(draftOf(user));
    setError(null);
  }, [visible, user]);

  const current = draftOf(user);
  const dirty =
    draft.firstName !== current.firstName ||
    draft.middleName !== current.middleName ||
    draft.lastName !== current.lastName ||
    (isAdmin && (draft.email !== current.email || draft.username !== current.username));

  // Admins may edit the sign-in identity, so it has to pass the same checks the server
  // applies. Non-admins never send these.
  const valid =
    draft.firstName.trim().length > 0 &&
    draft.lastName.trim().length > 0 &&
    (!isAdmin ||
      ((draft.email.trim() === '' || draft.email.trim().includes('@')) && draft.username.trim().length > 0));

  async function save() {
    setBusy(true);
    setError(null);
    try {
      const updated = await authApi.updateProfile(token ?? '', {
        firstName: draft.firstName.trim(),
        middleName: draft.middleName.trim() || null,
        lastName: draft.lastName.trim(),
        // Only admins may change these; a user would get a 403, so they are left off.
        ...(isAdmin ? { email: draft.email.trim(), username: draft.username.trim() } : {}),
      });
      // The header and greeting read from context, so they follow immediately.
      setUser(updated);
      onSaved();
      onClose();
    } catch (caught) {
      setError((caught as Error).message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <BottomSheet visible={visible} title="Edit profile" onClose={onClose}>
      <form
        className="flex flex-col gap-4"
        onSubmit={(event) => {
          event.preventDefault();
          if (dirty && valid && !busy) void save();
        }}>
        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="First name">
            <IconInput
              icon={IdentificationCardIcon}
              iconColor={primary.hex}
              value={draft.firstName}
              onChange={(event) => setDraft((p) => ({ ...p, firstName: event.target.value }))}
              autoComplete="given-name"
              placeholder="Maria"
            />
          </Field>
          <Field label="Last name">
            <IconInput
              icon={IdentificationCardIcon}
              iconColor={primary.hex}
              value={draft.lastName}
              onChange={(event) => setDraft((p) => ({ ...p, lastName: event.target.value }))}
              autoComplete="family-name"
              placeholder="Santos"
            />
          </Field>
        </div>

        <Field label="Middle name" hint="Optional">
          <IconInput
            icon={IdentificationCardIcon}
            iconColor={primary.hex}
            value={draft.middleName}
            onChange={(event) => setDraft((p) => ({ ...p, middleName: event.target.value }))}
            autoComplete="additional-name"
            placeholder="Luisa"
          />
        </Field>

        {isAdmin ? (
          <>
            <Field label="Username">
              <IconInput
                icon={AtIcon}
                iconColor={primary.hex}
                value={draft.username}
                onChange={(event) => setDraft((p) => ({ ...p, username: event.target.value.toLowerCase() }))}
                autoCapitalize="none"
                autoCorrect="off"
                spellCheck={false}
                autoComplete="username"
                placeholder="username"
              />
            </Field>
            <Field label="Email" hint="Optional">
              <IconInput
                icon={EnvelopeIcon}
                iconColor={primary.hex}
                value={draft.email}
                onChange={(event) => setDraft((p) => ({ ...p, email: event.target.value }))}
                type="email"
                inputMode="email"
                autoCapitalize="none"
                autoComplete="email"
                placeholder="you@example.com"
              />
            </Field>
          </>
        ) : null}

        {error ? <Callout tone="destructive" title={error} /> : null}

        <FormActions busy={busy} canSave={dirty && valid} saveLabel="Save changes" onCancel={onClose} />
      </form>
    </BottomSheet>
  );
}

/**
 * Kept apart from the name form: changing a password needs the current one, and mixing
 * that into the same Save would make an innocuous rename ask for it too.
 */
export function PasswordSheet({
  visible,
  onClose,
  onSaved,
}: {
  visible: boolean;
  onClose: () => void;
  onSaved: () => void;
}) {
  const { token } = useAuth();
  const { primary } = useAppearance();

  const [currentPassword, setCurrentPassword] = useState('');
  const [newPassword, setNewPassword] = useState('');
  const [reveal, setReveal] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Never reopens with a password still filled in.
  useEffect(() => {
    if (!visible) return;
    setCurrentPassword('');
    setNewPassword('');
    setReveal(false);
    setError(null);
  }, [visible]);

  const canSave = currentPassword.length > 0 && newPassword.length >= MIN_PASSWORD;

  async function save() {
    setBusy(true);
    setError(null);
    try {
      await authApi.changePassword(token ?? '', currentPassword, newPassword);
      onSaved();
      onClose();
    } catch (caught) {
      setError((caught as Error).message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <BottomSheet visible={visible} title="Change password" onClose={onClose}>
      <form
        className="flex flex-col gap-4"
        onSubmit={(event) => {
          event.preventDefault();
          if (canSave && !busy) void save();
        }}>
        <Field label="Current password">
          <IconInput
            icon={LockIcon}
            iconColor={primary.hex}
            value={currentPassword}
            onChange={(event) => setCurrentPassword(event.target.value)}
            type={reveal ? 'text' : 'password'}
            autoComplete="current-password"
            placeholder="Your current password"
            action={{
              icon: reveal ? EyeSlashIcon : EyeIcon,
              label: reveal ? 'Hide passwords' : 'Show passwords',
              onClick: () => setReveal((v) => !v),
            }}
          />
        </Field>

        <Field label="New password" hint={`${MIN_PASSWORD}+ characters`}>
          <IconInput
            icon={LockIcon}
            iconColor={primary.hex}
            value={newPassword}
            onChange={(event) => setNewPassword(event.target.value)}
            type={reveal ? 'text' : 'password'}
            autoComplete="new-password"
            placeholder="Your new password"
          />
        </Field>

        <p className="text-muted-foreground text-xs">You stay signed in on this device.</p>

        {error ? <Callout tone="destructive" title={error} /> : null}

        <FormActions busy={busy} canSave={canSave} saveLabel="Change password" onCancel={onClose} />
      </form>
    </BottomSheet>
  );
}
