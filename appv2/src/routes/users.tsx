import {
  AtIcon,
  CaretRightIcon,
  CheckIcon,
  EnvelopeIcon,
  EyeIcon,
  EyeSlashIcon,
  HardHatIcon,
  IdentificationCardIcon,
  LockIcon,
  MagnifyingGlassIcon,
  PlusIcon,
  SparkleIcon,
  TrashIcon,
  UsersIcon,
  UsersThreeIcon,
  WrenchIcon,
  XIcon,
} from '@phosphor-icons/react';
import { useCallback, useEffect, useState, type ReactNode } from 'react';
import { Navigate } from 'react-router';

import { BottomSheet } from '@/components/bottom-sheet';
import { ConfirmModal } from '@/components/confirm-modal';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Callout, type CalloutTone } from '@/components/ui/callout';
import { EmptyState } from '@/components/ui/empty-state';
import { IconInput } from '@/components/ui/icon-input';
import { PageHeader } from '@/components/ui/page-header';
import { SearchField } from '@/components/ui/search-field';
import { Segmented } from '@/components/ui/segmented';
import { SettingsSection } from '@/components/ui/settings-list';
import { Skeleton } from '@/components/ui/skeleton';
import { useAuth } from '@/features/auth/context';
import type { Role } from '@/features/auth/types';
import * as usersApi from '@/features/users/api';
import type { ManagedUser } from '@/features/users/types';
import { useDebounced } from '@/hooks/use-debounced';
import { useAppearance } from '@/lib/appearance';
import { formatDateTime } from '@/lib/datetime';
import { cn } from '@/lib/utils';

const MIN_PASSWORD = 8;

/** How long a confirmation such as "Account created" stays up. */
const NOTICE_MS = 4000;

// Same icons as the sign-in role picker: Wrench for the maintenance engineer, HardHat for
// the power utility personnel.
const ROLES: { label: string; value: Role; icon: typeof WrenchIcon }[] = [
  { label: 'User', value: 'user', icon: HardHatIcon },
  { label: 'Admin', value: 'admin', icon: WrenchIcon },
];

const ROLE_TITLE: Record<Role, string> = {
  admin: 'Maintenance Engineer. Everything, including settings and accounts.',
  user: 'Power Utility Personnel. Monitoring and alerts.',
};

/** Admins first: there are fewer of them, and they are who an admin looks for. */
const GROUPS: { role: Role; title: string }[] = [
  { role: 'admin', title: 'Admins' },
  { role: 'user', title: 'Users' },
];

type Draft = {
  firstName: string;
  middleName: string;
  lastName: string;
  username: string;
  email: string;
  password: string;
  role: Role;
};

const EMPTY: Draft = {
  firstName: '',
  middleName: '',
  lastName: '',
  username: '',
  email: '',
  password: '',
  role: 'user',
};

type Notice = { tone: CalloutTone; title: string; description?: string };

function initials(row: ManagedUser): string {
  const fromName = `${row.firstName.trim().charAt(0)}${row.lastName.trim().charAt(0)}`;
  return (fromName || row.username.slice(0, 2)).toUpperCase();
}

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

export default function UsersScreen() {
  const { token, user } = useAuth();
  const { primary } = useAppearance();

  const [rows, setRows] = useState<ManagedUser[]>([]);
  const [loading, setLoading] = useState(true);
  const [adding, setAdding] = useState(false);
  const [editing, setEditing] = useState<ManagedUser | null>(null);
  const [draft, setDraft] = useState<Draft>(EMPTY);
  const [reveal, setReveal] = useState(false);
  const [busy, setBusy] = useState(false);
  const [generating, setGenerating] = useState(false);
  /** A problem with the form, shown inside the sheet. */
  const [formError, setFormError] = useState<string | null>(null);
  /** What happened on the page: created, updated, deleted, or a load that failed. */
  const [notice, setNotice] = useState<Notice | null>(null);
  const [query, setQuery] = useState('');
  const [pendingDelete, setPendingDelete] = useState<ManagedUser | null>(null);
  const [deleting, setDeleting] = useState(false);
  /** The pending account being approved, so only its button shows progress. */
  const [approving, setApproving] = useState<string | null>(null);

  const debouncedQuery = useDebounced(query);

  const refresh = useCallback(async () => {
    setLoading(true);
    try {
      setRows(await usersApi.list(token ?? '', { q: debouncedQuery }));
    } catch (caught) {
      setNotice({
        tone: 'destructive',
        title: 'Could not load accounts',
        description: (caught as Error).message,
      });
    } finally {
      setLoading(false);
    }
  }, [token, debouncedQuery]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  // A confirmation is a moment, not a state, so it clears itself. Errors stay.
  useEffect(() => {
    if (notice?.tone !== 'success') return;
    const timer = setTimeout(() => setNotice(null), NOTICE_MS);
    return () => clearTimeout(timer);
  }, [notice]);

  function closeSheet() {
    setDraft(EMPTY);
    setAdding(false);
    setEditing(null);
    setReveal(false);
    setFormError(null);
  }

  function startAdd() {
    setDraft(EMPTY);
    setReveal(false);
    setFormError(null);
    setAdding(true);
  }

  function startEdit(row: ManagedUser) {
    setDraft({
      firstName: row.firstName,
      middleName: row.middleName ?? '',
      lastName: row.lastName,
      username: row.username,
      email: row.email ?? '',
      password: '',
      role: row.role,
    });
    setReveal(false);
    setFormError(null);
    setEditing(row);
  }

  async function generateUsername() {
    if (!draft.firstName.trim() || !draft.lastName.trim()) {
      setFormError('Enter a first and last name before generating a username.');
      return;
    }
    setGenerating(true);
    setFormError(null);
    try {
      const { username } = await usersApi.suggestUsername(
        token ?? '',
        draft.firstName.trim(),
        draft.lastName.trim(),
      );
      setDraft((p) => ({ ...p, username }));
    } catch (caught) {
      setFormError((caught as Error).message);
    } finally {
      setGenerating(false);
    }
  }

  async function create() {
    setBusy(true);
    setFormError(null);
    try {
      await usersApi.create(token ?? '', {
        email: draft.email.trim(),
        password: draft.password,
        role: draft.role,
        firstName: draft.firstName.trim(),
        middleName: draft.middleName.trim() || null,
        lastName: draft.lastName.trim(),
        // Blank lets the server's formula generate one.
        username: draft.username.trim() || undefined,
      });
      const name = `${draft.firstName.trim()} ${draft.lastName.trim()}`;
      closeSheet();
      setNotice({ tone: 'success', title: 'Account created', description: name });
      await refresh();
    } catch (caught) {
      setFormError((caught as Error).message);
    } finally {
      setBusy(false);
    }
  }

  async function update() {
    if (!editing) return;
    setBusy(true);
    setFormError(null);
    try {
      const updated = await usersApi.update(token ?? '', editing.id, {
        email: draft.email.trim(),
        role: draft.role,
        firstName: draft.firstName.trim(),
        middleName: draft.middleName.trim() || null,
        lastName: draft.lastName.trim(),
        // Blank keeps the current username; blank keeps the current password.
        username: draft.username.trim() || undefined,
        password: draft.password || undefined,
      });
      setRows((prev) => prev.map((row) => (row.id === updated.id ? updated : row)));
      closeSheet();
      setNotice({
        tone: 'success',
        title: 'Account updated',
        description: updated.fullName || updated.username,
      });
    } catch (caught) {
      setFormError((caught as Error).message);
    } finally {
      setBusy(false);
    }
  }

  async function approve(row: ManagedUser) {
    setApproving(row.id);
    try {
      const updated = await usersApi.approve(token ?? '', row.id);
      setRows((prev) => prev.map((existing) => (existing.id === updated.id ? updated : existing)));
      setNotice({
        tone: 'success',
        title: 'Account approved',
        description: `${updated.fullName || updated.username} can sign in now.`,
      });
    } catch (caught) {
      setNotice({
        tone: 'destructive',
        title: 'Could not approve the account',
        description: (caught as Error).message,
      });
    } finally {
      setApproving(null);
    }
  }

  async function remove() {
    if (!pendingDelete) return;
    const target = pendingDelete;
    const rejecting = target.status === 'pending';
    setDeleting(true);
    try {
      await usersApi.remove(token ?? '', target.id);
      setPendingDelete(null);
      setNotice({
        tone: 'success',
        title: rejecting ? 'Request rejected' : 'Account deleted',
        description: target.fullName || target.username,
      });
      await refresh();
    } catch (caught) {
      setPendingDelete(null);
      setNotice({
        tone: 'destructive',
        title: 'Could not delete the account',
        description: (caught as Error).message,
      });
    } finally {
      setDeleting(false);
    }
  }

  const pending = rows.filter((row) => row.status === 'pending');
  const active = rows.filter((row) => row.status !== 'pending');
  const isEditing = editing !== null;
  const editingSelf = editing?.id === user?.id;
  const filtered = Boolean(debouncedQuery.trim());

  const namesValid =
    draft.firstName.trim().length > 0 &&
    draft.lastName.trim().length > 0 &&
    (draft.email.trim() === '' || draft.email.trim().includes('@'));
  // When editing, the password is optional (blank keeps the current one), but any value
  // given must still clear the minimum.
  const passwordValid = isEditing
    ? draft.password.length === 0 || draft.password.length >= MIN_PASSWORD
    : draft.password.length >= MIN_PASSWORD;
  const canSubmit = namesValid && passwordValid && !busy;

  // The API refuses both of these anyway; saying so in the button beats a refusal after the
  // tap. An admin has to be demoted before it can be removed, so losing admin access takes
  // two deliberate steps.
  const deleteBlocked = editingSelf
    ? 'This is you'
    : editing?.role === 'admin'
      ? 'Demote to user first'
      : null;

  // The Settings link is hidden from non-admins, but this page is still reachable by URL.
  // The API enforces this too; the redirect just avoids a wall of 403s.
  if (!token) return <Navigate to="/login" replace />;
  if (user && user.role !== 'admin') return <Navigate to="/dashboard" replace />;

  return (
    <>
      <PageHeader
        icon={UsersIcon}
        iconColor={primary.hex}
        title="User accounts"
        back={{ to: '/settings', label: 'Back to settings' }}
        actions={
          <Button size="sm" onClick={startAdd}>
            <PlusIcon weight="bold" aria-hidden="true" />
            New
          </Button>
        }
      />

      {notice ? <Callout tone={notice.tone} title={notice.title} description={notice.description} /> : null}

      <SearchField value={query} onValueChange={setQuery} placeholder="Search by name, username or email" />

      {loading ? (
        <SettingsSection title="Accounts">
          {[0, 1, 2].map((row) => (
            <div key={row} className="flex items-center gap-3 px-4 py-3">
              <Skeleton className="size-10 rounded-full" />
              <div className="flex-1 space-y-1.5">
                <Skeleton className="h-4 w-36" />
                <Skeleton className="h-3 w-48" />
              </div>
            </div>
          ))}
        </SettingsSection>
      ) : rows.length === 0 ? (
        <EmptyState
          icon={filtered ? MagnifyingGlassIcon : UsersThreeIcon}
          title={filtered ? 'No matching accounts' : 'No accounts yet'}
          description={filtered ? 'Try a different search.' : 'Add an account to get started.'}
        />
      ) : (
        <>
          {pending.length > 0 ? (
            <SettingsSection title={`Pending approval · ${pending.length}`}>
              {pending.map((row) => (
                <div key={row.id} className="flex flex-col gap-3 px-4 py-3 sm:flex-row sm:items-center">
                  <div className="flex min-w-0 flex-1 items-center gap-3">
                    <span
                      aria-hidden="true"
                      className="grid size-10 shrink-0 place-items-center rounded-full bg-amber-500/15 text-sm font-bold text-amber-700 dark:text-amber-400">
                      {initials(row)}
                    </span>
                    <span className="min-w-0 flex-1">
                      <span className="block text-sm font-semibold leading-tight">
                        {row.fullName || row.username}
                      </span>
                      <span className="text-muted-foreground block break-words text-xs">
                        @{row.username}
                        {row.email ? ` · ${row.email}` : ''} · {formatDateTime(row.createdAt)}
                      </span>
                    </span>
                  </div>
                  <span className="flex gap-2 sm:shrink-0">
                    <Button
                      variant="outline"
                      size="sm"
                      className="text-destructive hover:text-destructive flex-1 sm:flex-none"
                      disabled={approving === row.id}
                      onClick={() => setPendingDelete(row)}>
                      <XIcon weight="bold" aria-hidden="true" />
                      Reject
                    </Button>
                    <Button
                      size="sm"
                      className="flex-1 sm:flex-none"
                      disabled={approving === row.id}
                      onClick={() => void approve(row)}>
                      <CheckIcon weight="bold" aria-hidden="true" />
                      {approving === row.id ? 'Approving…' : 'Approve'}
                    </Button>
                  </span>
                </div>
              ))}
            </SettingsSection>
          ) : null}

          {GROUPS.map(({ role, title }) => {
            const members = active.filter((row) => row.role === role);
            if (members.length === 0) return null;

            return (
              <SettingsSection key={role} title={`${title} · ${members.length}`}>
                {members.map((row) => {
                  const isSelf = row.id === user?.id;
                  const isAdmin = row.role === 'admin';

                  return (
                    <button
                      key={row.id}
                      type="button"
                      onClick={() => startEdit(row)}
                      className="hover:bg-accent/60 active:bg-accent flex w-full cursor-pointer items-center gap-3 px-4 py-3 text-left transition-colors">
                      <span
                        aria-hidden="true"
                        className={cn(
                          'grid size-10 shrink-0 place-items-center rounded-full text-sm font-bold',
                          !isAdmin && 'bg-muted text-muted-foreground',
                        )}
                        style={
                          isAdmin ? { backgroundColor: `${primary.hex}1f`, color: primary.hex } : undefined
                        }>
                        {initials(row)}
                      </span>
                      <span className="min-w-0 flex-1">
                        <span className="flex items-center gap-2">
                          <span className="text-sm font-semibold leading-tight">
                            {row.fullName || row.username}
                          </span>
                          {isSelf ? <Badge variant="outline">You</Badge> : null}
                        </span>
                        <span className="text-muted-foreground block break-words text-xs">
                          @{row.username}
                          {row.email ? ` · ${row.email}` : ''}
                        </span>
                      </span>
                      <CaretRightIcon
                        size={14}
                        weight="bold"
                        className="text-muted-foreground"
                        aria-hidden="true"
                      />
                    </button>
                  );
                })}
              </SettingsSection>
            );
          })}
        </>
      )}

      <BottomSheet
        visible={adding || isEditing}
        title={isEditing ? 'Edit account' : 'New account'}
        onClose={closeSheet}>
        <form
          className="flex flex-col gap-4"
          onSubmit={(event) => {
            event.preventDefault();
            if (canSubmit) void (isEditing ? update() : create());
          }}>
          <div className="grid gap-4 sm:grid-cols-2">
            <Field label="First name">
              <IconInput
                icon={IdentificationCardIcon}
                iconColor={primary.hex}
                value={draft.firstName}
                onChange={(event) => setDraft((p) => ({ ...p, firstName: event.target.value }))}
                autoComplete="off"
                placeholder="Maria"
              />
            </Field>
            <Field label="Last name">
              <IconInput
                icon={IdentificationCardIcon}
                iconColor={primary.hex}
                value={draft.lastName}
                onChange={(event) => setDraft((p) => ({ ...p, lastName: event.target.value }))}
                autoComplete="off"
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
              autoComplete="off"
              placeholder="Luisa"
            />
          </Field>

          <Field label="Username" hint="Blank generates one">
            <span className="flex items-center gap-2">
              <IconInput
                containerClassName="flex-1"
                icon={AtIcon}
                iconColor={primary.hex}
                value={draft.username}
                onChange={(event) => setDraft((p) => ({ ...p, username: event.target.value }))}
                autoCapitalize="none"
                autoCorrect="off"
                spellCheck={false}
                autoComplete="off"
                placeholder="From the name"
              />
              <Button variant="outline" disabled={generating} onClick={() => void generateUsername()}>
                <SparkleIcon weight="bold" color={primary.hex} aria-hidden="true" />
                {generating ? '...' : 'Generate'}
              </Button>
            </span>
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
              autoComplete="off"
              placeholder="them@example.com"
            />
          </Field>

          <Field
            label={isEditing ? 'New password' : 'Password'}
            hint={isEditing ? 'Blank keeps the current one' : `${MIN_PASSWORD}+ characters`}>
            <IconInput
              icon={LockIcon}
              iconColor={primary.hex}
              value={draft.password}
              onChange={(event) => setDraft((p) => ({ ...p, password: event.target.value }))}
              type={reveal ? 'text' : 'password'}
              autoComplete="new-password"
              placeholder={isEditing ? 'Unchanged' : 'Their first password'}
              action={{
                icon: reveal ? EyeSlashIcon : EyeIcon,
                label: reveal ? 'Hide password' : 'Show password',
                onClick: () => setReveal((v) => !v),
              }}
            />
          </Field>

          <div className="space-y-1.5">
            <p className="text-sm font-medium">Role</p>
            <Segmented
              aria-label="Role"
              fill
              options={editingSelf ? ROLES.map((r) => ({ ...r, disabled: true })) : ROLES}
              value={draft.role}
              onValueChange={(role) => setDraft((p) => ({ ...p, role }))}
            />
            <p className="text-muted-foreground text-[11px]">
              {editingSelf ? 'You cannot change your own role.' : ROLE_TITLE[draft.role]}
            </p>
          </div>

          {formError ? <Callout tone="destructive" title={formError} /> : null}

          <div className="flex gap-2">
            <Button variant="outline" className="flex-1" disabled={busy} onClick={closeSheet}>
              Cancel
            </Button>
            <Button type="submit" className="flex-1" disabled={!canSubmit}>
              <CheckIcon weight="bold" aria-hidden="true" />
              {busy ? 'Saving...' : isEditing ? 'Save changes' : 'Create account'}
            </Button>
          </div>

          {editing ? (
            <div className="flex items-center justify-between gap-3 border-t pt-4">
              <p className="text-muted-foreground text-[11px]">Added {formatDateTime(editing.createdAt)}</p>
              <Button
                variant="ghost"
                size="sm"
                className="text-destructive hover:text-destructive disabled:text-muted-foreground"
                disabled={deleteBlocked !== null || busy}
                onClick={() => {
                  const target = editing;
                  closeSheet();
                  setPendingDelete(target);
                }}>
                <TrashIcon weight="bold" aria-hidden="true" />
                {deleteBlocked ?? 'Delete account'}
              </Button>
            </div>
          ) : null}
        </form>
      </BottomSheet>

      <ConfirmModal
        visible={pendingDelete !== null}
        title={pendingDelete?.status === 'pending' ? 'Reject request?' : 'Delete account?'}
        message={
          pendingDelete?.status === 'pending'
            ? `${pendingDelete.fullName || pendingDelete.username} will not be able to sign in. They can register again.`
            : `${pendingDelete?.fullName || pendingDelete?.username} will lose access immediately. This cannot be undone.`
        }
        confirmLabel={pendingDelete?.status === 'pending' ? 'Reject' : 'Delete account'}
        destructive
        busy={deleting}
        onConfirm={() => void remove()}
        onClose={() => setPendingDelete(null)}
      />
    </>
  );
}
