import {
  AtIcon,
  EnvelopeIcon,
  EyeIcon,
  EyeSlashIcon,
  IdentificationCardIcon,
  LockIcon,
} from '@phosphor-icons/react';
import { useState } from 'react';

import { Field } from '@/components/auth/field';
import { Button } from '@/components/ui/button';
import { Callout } from '@/components/ui/callout';
import { IconInput } from '@/components/ui/icon-input';
import { Spinner } from '@/components/ui/spinner';
import * as authApi from '@/features/auth/api';
import { useAppearance } from '@/lib/appearance';

const MIN_PASSWORD = 8;

/**
 * Sign-up for power utility personnel. The account waits for an admin to approve it, so
 * nothing here signs anyone in; it hands back the username to sign in with later.
 */
export function RegisterForm({ onRegistered }: { onRegistered: (username: string) => void }) {
  const { primary } = useAppearance();

  const [draft, setDraft] = useState({ firstName: '', lastName: '', username: '', email: '', password: '' });
  const [reveal, setReveal] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const set = (key: keyof typeof draft) => (event: React.ChangeEvent<HTMLInputElement>) =>
    setDraft((current) => ({ ...current, [key]: event.target.value }));

  const email = draft.email.trim();
  const canSubmit =
    draft.firstName.trim().length > 0 &&
    draft.lastName.trim().length > 0 &&
    (email === '' || email.includes('@')) &&
    draft.password.length >= MIN_PASSWORD &&
    !busy;

  async function submit() {
    setBusy(true);
    setError(null);
    try {
      const { username } = await authApi.register({
        firstName: draft.firstName.trim(),
        middleName: null,
        lastName: draft.lastName.trim(),
        username: draft.username.trim() || undefined,
        email: email || undefined,
        password: draft.password,
      });
      onRegistered(username);
    } catch (caught) {
      setError((caught as Error).message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <form
      className="flex flex-col gap-4"
      onSubmit={(event) => {
        event.preventDefault();
        if (canSubmit) void submit();
      }}>
      <div className="grid gap-4 sm:grid-cols-2">
        <Field label="First name">
          <IconInput
            icon={IdentificationCardIcon}
            iconColor={primary.hex}
            value={draft.firstName}
            onChange={set('firstName')}
            autoComplete="given-name"
            placeholder="Maria"
          />
        </Field>
        <Field label="Last name">
          <IconInput
            icon={IdentificationCardIcon}
            iconColor={primary.hex}
            value={draft.lastName}
            onChange={set('lastName')}
            autoComplete="family-name"
            placeholder="Santos"
          />
        </Field>
      </div>

      <Field label="Username" hint="Blank makes one from your name">
        <IconInput
          icon={AtIcon}
          iconColor={primary.hex}
          value={draft.username}
          onChange={set('username')}
          autoCapitalize="none"
          autoCorrect="off"
          spellCheck={false}
          autoComplete="username"
          placeholder="msantos"
        />
      </Field>

      <Field label="Email" hint="Optional">
        <IconInput
          icon={EnvelopeIcon}
          iconColor={primary.hex}
          value={draft.email}
          onChange={set('email')}
          type="email"
          inputMode="email"
          autoCapitalize="none"
          autoComplete="email"
          placeholder="you@example.com"
        />
      </Field>

      <Field label="Password" hint={`${MIN_PASSWORD}+ characters`}>
        <IconInput
          icon={LockIcon}
          iconColor={primary.hex}
          value={draft.password}
          onChange={set('password')}
          type={reveal ? 'text' : 'password'}
          autoComplete="new-password"
          placeholder="Choose a password"
          action={{
            icon: reveal ? EyeSlashIcon : EyeIcon,
            label: reveal ? 'Hide password' : 'Show password',
            onClick: () => setReveal((v) => !v),
          }}
        />
      </Field>

      <p className="text-muted-foreground text-xs">
        New accounts are for power utility personnel. An admin approves yours before you can sign in.
      </p>

      {error ? <Callout tone="destructive" title={error} /> : null}

      <Button type="submit" size="lg" disabled={!canSubmit}>
        {busy ? <Spinner className="size-4" /> : 'Create account'}
      </Button>
    </form>
  );
}
