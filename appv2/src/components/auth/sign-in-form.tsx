import { EnvelopeIcon, EyeIcon, EyeSlashIcon, HardHatIcon, LockIcon, WrenchIcon } from '@phosphor-icons/react';
import { useState } from 'react';

import { Field } from '@/components/auth/field';
import { Button } from '@/components/ui/button';
import { Callout } from '@/components/ui/callout';
import { IconInput } from '@/components/ui/icon-input';
import { Segmented } from '@/components/ui/segmented';
import { Spinner } from '@/components/ui/spinner';
import { useAuth } from '@/features/auth/context';
import type { Role } from '@/features/auth/types';
import { ApiError } from '@/lib/api-client';
import { useAppearance } from '@/lib/appearance';

const ROLES = [
  { label: 'User', value: 'user' as Role, icon: HardHatIcon },
  { label: 'Admin', value: 'admin' as Role, icon: WrenchIcon },
];

type Problem = { pending: boolean; message: string };

export function SignInForm({ initialIdentifier = '' }: { initialIdentifier?: string }) {
  const { signIn } = useAuth();
  const { primary } = useAppearance();

  const [identifier, setIdentifier] = useState(initialIdentifier);
  const [password, setPassword] = useState('');
  const [role, setRole] = useState<Role>('user');
  const [reveal, setReveal] = useState(false);
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<Problem | null>(null);

  const canSubmit = identifier.trim().length > 0 && password.length > 0 && !busy;

  async function submit() {
    setBusy(true);
    setProblem(null);
    try {
      await signIn(identifier.trim(), password, role);
    } catch (caught) {
      // A registered account an admin has not approved yet is not a mistake to correct,
      // so it reads as a status rather than an error.
      const pending = caught instanceof ApiError && caught.status === 403;
      setProblem({ pending, message: (caught as Error).message });
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
      <div className="space-y-1.5">
        <p className="text-sm font-medium">Signing in as</p>
        <Segmented fill aria-label="Role" options={ROLES} value={role} onValueChange={setRole} />
      </div>

      <Field label="Email or username">
        <IconInput
          icon={EnvelopeIcon}
          iconColor={primary.hex}
          value={identifier}
          onChange={(event) => setIdentifier(event.target.value)}
          autoCapitalize="none"
          autoCorrect="off"
          spellCheck={false}
          autoComplete="username"
          placeholder="you@example.com"
        />
      </Field>

      <Field label="Password">
        <IconInput
          icon={LockIcon}
          iconColor={primary.hex}
          value={password}
          onChange={(event) => setPassword(event.target.value)}
          type={reveal ? 'text' : 'password'}
          autoComplete="current-password"
          placeholder="Your password"
          action={{
            icon: reveal ? EyeSlashIcon : EyeIcon,
            label: reveal ? 'Hide password' : 'Show password',
            onClick: () => setReveal((v) => !v),
          }}
        />
      </Field>

      {problem ? (
        problem.pending ? (
          <Callout tone="warning" title="Waiting for approval" description={problem.message} />
        ) : (
          <Callout tone="destructive" title={problem.message} />
        )
      ) : null}

      <Button type="submit" size="lg" disabled={!canSubmit}>
        {busy ? <Spinner className="size-4" /> : 'Sign in'}
      </Button>
    </form>
  );
}
