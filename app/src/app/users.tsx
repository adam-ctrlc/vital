import { Redirect, router } from 'expo-router';
import { useColorScheme } from 'nativewind';
import At from 'phosphor-react-native/src/icons/At';
import CaretLeft from 'phosphor-react-native/src/icons/CaretLeft';
import Check from 'phosphor-react-native/src/icons/Check';
import Envelope from 'phosphor-react-native/src/icons/Envelope';
import Eye from 'phosphor-react-native/src/icons/Eye';
import EyeSlash from 'phosphor-react-native/src/icons/EyeSlash';
import FunnelSimple from 'phosphor-react-native/src/icons/FunnelSimple';
import HardHat from 'phosphor-react-native/src/icons/HardHat';
import IdentificationCard from 'phosphor-react-native/src/icons/IdentificationCard';
import Lock from 'phosphor-react-native/src/icons/Lock';
import PencilSimple from 'phosphor-react-native/src/icons/PencilSimple';
import Sparkle from 'phosphor-react-native/src/icons/Sparkle';
import Trash from 'phosphor-react-native/src/icons/Trash';
import UserPlus from 'phosphor-react-native/src/icons/UserPlus';
import MagnifyingGlass from 'phosphor-react-native/src/icons/MagnifyingGlass';
import Users from 'phosphor-react-native/src/icons/Users';
import UsersThree from 'phosphor-react-native/src/icons/UsersThree';
import Wrench from 'phosphor-react-native/src/icons/Wrench';
import X from 'phosphor-react-native/src/icons/X';
import { useCallback, useEffect, useState } from 'react';
import { KeyboardAvoidingView, ScrollView, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

import { BottomSheet } from '@/components/bottom-sheet';
import { ConfirmModal } from '@/components/confirm-modal';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardTitle } from '@/components/ui/card';
import { EmptyState } from '@/components/ui/empty-state';
import { IconInput } from '@/components/ui/icon-input';
import { SearchField } from '@/components/ui/search-field';
import { Segmented } from '@/components/ui/segmented';
import { Skeleton } from '@/components/ui/skeleton';
import { Text } from '@/components/ui/text';
import { useAuth } from '@/features/auth/context';
import type { Role } from '@/features/auth/types';
import * as usersApi from '@/features/users/api';
import type { ManagedUser } from '@/features/users/types';
import { useDebounced } from '@/hooks/use-debounced';
import { useAppearance } from '@/lib/appearance';
import { formatDateTime } from '@/lib/datetime';

/** Matches `--primary-foreground`, which the appearance provider pins to white. */
const ON_PRIMARY = '#ffffff';
const MIN_PASSWORD = 8;

const ROLES: { label: string; value: Role }[] = [
  { label: 'User', value: 'user' },
  { label: 'Admin', value: 'admin' },
];

const ROLE_FILTERS: { label: string; value: Role | null; icon: typeof Wrench }[] = [
  { label: 'All roles', value: null, icon: FunnelSimple },
  // Same icons as the login role picker: Wrench for the maintenance engineer, HardHat
  // for the power utility personnel.
  { label: 'Admins', value: 'admin', icon: Wrench },
  { label: 'Users', value: 'user', icon: HardHat },
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

function Field({ label, hint, children }: { label: string; hint?: string; children: React.ReactNode }) {
  return (
    <View className="gap-1.5">
      <View className="flex-row items-baseline justify-between">
        <Text className="text-sm font-medium">{label}</Text>
        {hint ? (
          <Text variant="muted" className="text-[10px]">
            {hint}
          </Text>
        ) : null}
      </View>
      {children}
    </View>
  );
}

export default function UsersScreen() {
  const { token, user } = useAuth();
  const { primary } = useAppearance();
  const { colorScheme } = useColorScheme();
  const isDark = colorScheme === 'dark';
  const muted = isDark ? '#a1a1aa' : '#71717a';
  const danger = isDark ? '#f87171' : '#dc2626';
  const fg = isDark ? '#fafafa' : '#0a0a0a';

  const [rows, setRows] = useState<ManagedUser[]>([]);
  const [loading, setLoading] = useState(true);
  const [adding, setAdding] = useState(false);
  const [editing, setEditing] = useState<ManagedUser | null>(null);
  const [draft, setDraft] = useState<Draft>(EMPTY);
  const [reveal, setReveal] = useState(false);
  const [busy, setBusy] = useState(false);
  const [generating, setGenerating] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [status, setStatus] = useState<string | null>(null);
  const [query, setQuery] = useState('');
  const [roleFilter, setRoleFilter] = useState<Role | null>(null);
  const [pendingDelete, setPendingDelete] = useState<ManagedUser | null>(null);
  const [deleting, setDeleting] = useState(false);

  const debouncedQuery = useDebounced(query);

  const refresh = useCallback(async () => {
    setLoading(true);
    try {
      setRows(await usersApi.list(token ?? '', { q: debouncedQuery, role: roleFilter ?? undefined }));
      setError(null);
    } catch (caught) {
      setError((caught as Error).message);
    } finally {
      setLoading(false);
    }
  }, [token, debouncedQuery, roleFilter]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  function cancel() {
    setDraft(EMPTY);
    setAdding(false);
    setEditing(null);
    setReveal(false);
    setError(null);
  }

  function startEdit(row: ManagedUser) {
    setDraft({
      firstName: row.firstName,
      middleName: row.middleName ?? '',
      lastName: row.lastName,
      username: row.username,
      email: row.email,
      password: '',
      role: row.role,
    });
    setReveal(false);
    setError(null);
    setStatus(null);
    setEditing(row);
  }

  async function generateUsername() {
    if (!draft.firstName.trim() || !draft.lastName.trim()) {
      setError('Enter a first and last name before generating a username.');
      return;
    }
    setGenerating(true);
    setError(null);
    try {
      const { username } = await usersApi.suggestUsername(
        token ?? '',
        draft.firstName.trim(),
        draft.lastName.trim()
      );
      setDraft((p) => ({ ...p, username }));
    } catch (caught) {
      setError((caught as Error).message);
    } finally {
      setGenerating(false);
    }
  }

  async function save() {
    setBusy(true);
    setError(null);
    setStatus(null);
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
      cancel();
      setStatus(`Account created for ${draft.email.trim()}`);
      await refresh();
    } catch (caught) {
      setError((caught as Error).message);
    } finally {
      setBusy(false);
    }
  }

  async function saveEdit() {
    if (!editing) return;
    setBusy(true);
    setError(null);
    setStatus(null);
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
      cancel();
      setStatus(`Account updated for ${updated.email}`);
    } catch (caught) {
      setError((caught as Error).message);
    } finally {
      setBusy(false);
    }
  }

  async function remove() {
    if (!pendingDelete) return;
    const target = pendingDelete;
    setDeleting(true);
    setError(null);
    setStatus(null);
    try {
      await usersApi.remove(token ?? '', target.id);
      setStatus(`Deleted ${target.fullName || target.email}`);
      setPendingDelete(null);
      await refresh();
    } catch (caught) {
      setError((caught as Error).message);
    } finally {
      setDeleting(false);
    }
  }

  const isEditing = editing !== null;
  const editingSelf = editing?.id === user?.id;

  const canSave =
    draft.firstName.trim().length > 0 &&
    draft.lastName.trim().length > 0 &&
    draft.email.trim().includes('@') &&
    draft.password.length >= MIN_PASSWORD &&
    !busy;

  // When editing, the password is optional (blank keeps the current one), but any
  // value given must still clear the minimum.
  const canSaveEdit =
    draft.firstName.trim().length > 0 &&
    draft.lastName.trim().length > 0 &&
    draft.email.trim().includes('@') &&
    (draft.password.length === 0 || draft.password.length >= MIN_PASSWORD) &&
    !busy;

  const canSubmit = isEditing ? canSaveEdit : canSave;
  const submit = isEditing ? saveEdit : save;

  // This screen sits outside the tabs group, so it cannot rely on that layout's
  // guard. The API enforces this too; the redirect just avoids a wall of 403s.
  if (!token) return <Redirect href="/login" />;
  if (user && user.role !== 'admin') return <Redirect href="/dashboard" />;

  // Bottom edge included: this screen sits outside the tabs group, so there is no tab bar
  // to take the navigation bar's inset for it, and the last row would fall behind it.
  return (
    <SafeAreaView className="bg-background flex-1" edges={['top', 'bottom']}>
      <KeyboardAvoidingView className="flex-1" behavior="padding">
      <ScrollView contentContainerClassName="gap-4 p-4 pb-8" keyboardShouldPersistTaps="handled"
        keyboardDismissMode="on-drag">
        <View className="flex-row items-center gap-2">
          <Button
            variant="ghost"
            size="icon"
            className="h-8 w-8 -ml-2 rounded-full"
            accessibilityLabel="Back to settings"
            onPress={() => router.back()}>
            <CaretLeft size={18} weight="bold" color={fg} />
          </Button>
          <Users size={22} weight="fill" color={primary.hex} />
          <Text className="text-lg font-bold">User Management</Text>
        </View>

        <Card className="py-0">
          <CardContent className="flex-row items-center justify-between p-4">
            <View className="flex-1 gap-0.5">
              <CardTitle className="text-base">Add an account</CardTitle>
              <Text variant="muted" className="text-xs">
                The role decides what they can reach.
              </Text>
            </View>
            <Button variant="outline" size="sm" onPress={() => setAdding(true)}>
              <UserPlus size={14} weight="bold" color={primary.hex} />
              <Text>New</Text>
            </Button>
          </CardContent>
        </Card>

        <BottomSheet
          visible={adding || isEditing}
          title={isEditing ? 'Edit account' : 'Add an account'}
          onClose={cancel}>
          <View className="gap-4">
            <Field label="First name">
                <IconInput
                  icon={IdentificationCard}
                  iconColor={primary.hex}
                  value={draft.firstName}
                  onChangeText={(firstName) => setDraft((p) => ({ ...p, firstName }))}
                  placeholder="Maria"
                />
              </Field>

              <Field label="Middle name" hint="Optional">
                <IconInput
                  icon={IdentificationCard}
                  iconColor={primary.hex}
                  value={draft.middleName}
                  onChangeText={(middleName) => setDraft((p) => ({ ...p, middleName }))}
                  placeholder="Luisa"
                />
              </Field>

              <Field label="Last name">
                <IconInput
                  icon={IdentificationCard}
                  iconColor={primary.hex}
                  value={draft.lastName}
                  onChangeText={(lastName) => setDraft((p) => ({ ...p, lastName }))}
                  placeholder="Santos"
                />
              </Field>

              <Field label="Username" hint="Leave blank to auto-generate">
                <View className="flex-row items-center gap-2">
                  <IconInput
                    containerClassName="flex-1"
                    icon={At}
                    iconColor={primary.hex}
                    value={draft.username}
                    onChangeText={(username) => setDraft((p) => ({ ...p, username }))}
                    autoCapitalize="none"
                    autoCorrect={false}
                    placeholder="Generated from the name"
                  />
                  <Button
                    variant="outline"
                    size="sm"
                    className="h-11"
                    disabled={generating}
                    onPress={() => void generateUsername()}>
                    <Sparkle size={14} weight="bold" color={primary.hex} />
                    <Text>{generating ? '...' : 'Generate'}</Text>
                  </Button>
                </View>
              </Field>

              <Field label="Email">
                <IconInput
                  icon={Envelope}
                  iconColor={primary.hex}
                  value={draft.email}
                  onChangeText={(email) => setDraft((p) => ({ ...p, email }))}
                  autoCapitalize="none"
                  autoCorrect={false}
                  keyboardType="email-address"
                  placeholder="them@example.com"
                />
              </Field>

              <Field
                label={isEditing ? 'New password' : 'Password'}
                hint={
                  isEditing
                    ? 'Leave blank to keep the current password'
                    : `${MIN_PASSWORD} characters or more`
                }>
                <IconInput
                  icon={Lock}
                  iconColor={primary.hex}
                  value={draft.password}
                  onChangeText={(password) => setDraft((p) => ({ ...p, password }))}
                  secureTextEntry={!reveal}
                  autoCapitalize="none"
                  autoCorrect={false}
                  placeholder={isEditing ? 'Leave blank to keep current' : 'Their first password'}
                  action={{
                    icon: reveal ? EyeSlash : Eye,
                    label: reveal ? 'Hide password' : 'Show password',
                    onPress: () => setReveal((v) => !v),
                  }}
                />
              </Field>

              <Field label="Role">
                <Segmented
                  options={editingSelf ? ROLES.map((r) => ({ ...r, disabled: true })) : ROLES}
                  value={draft.role}
                  onChange={(role) => setDraft((p) => ({ ...p, role }))}
                  activeColor={primary.hex}
                  inactiveColor={muted}
                  className="self-start"
                />
                {editingSelf ? (
                  <Text variant="muted" className="text-[10px]">
                    You cannot change your own role.
                  </Text>
                ) : null}
              </Field>

              {error ? <Text className="text-destructive text-sm">{error}</Text> : null}

              <View className="flex-row gap-2">
                <Button variant="outline" className="flex-1" disabled={busy} onPress={cancel}>
                  <X size={14} weight="bold" color={danger} />
                  <Text>Cancel</Text>
                </Button>
                <Button className="flex-1" disabled={!canSubmit} onPress={() => void submit()}>
                  <Check size={14} weight="bold" color={ON_PRIMARY} />
                  <Text numberOfLines={1}>
                    {busy ? 'Saving...' : isEditing ? 'Save changes' : 'Create'}
                  </Text>
                </Button>
              </View>
          </View>
        </BottomSheet>

        {error && !adding ? <Text className="text-destructive text-sm">{error}</Text> : null}
        {status ? <Text className="text-primary text-sm">{status}</Text> : null}

        <SearchField value={query} onChangeText={setQuery} placeholder="Search accounts..." />

        <View className="flex-row items-center gap-2">
          {ROLE_FILTERS.map((option) => {
            const selected = roleFilter === option.value;
            const Icon = option.icon;
            return (
              <Button
                key={option.label}
                variant={selected ? 'default' : 'outline'}
                size="sm"
                className="flex-1 px-1"
                onPress={() => setRoleFilter(option.value)}>
                <Icon size={14} weight="bold" color={selected ? ON_PRIMARY : muted} />
                <Text className="text-xs">{option.label}</Text>
              </Button>
            );
          })}
        </View>

        {loading ? (
          <Skeleton className="h-3 w-24" />
        ) : (
          <Text variant="muted" className="text-xs">
            {rows.length} account{rows.length === 1 ? '' : 's'}
            {debouncedQuery.trim() || roleFilter ? ' matching filters' : ''}
          </Text>
        )}

        {!loading && rows.length === 0 ? (
          <EmptyState
            icon={debouncedQuery.trim() || roleFilter ? MagnifyingGlass : UsersThree}
            title={debouncedQuery.trim() || roleFilter ? 'No matching accounts' : 'No accounts yet'}
            description={
              debouncedQuery.trim() || roleFilter
                ? 'Try a different search or role.'
                : 'Add an account to get started.'
            }
          />
        ) : null}

        {loading
          ? [0, 1, 2].map((row) => (
              <Card key={row} className="py-0">
                <CardContent className="gap-2 p-4">
                  <Skeleton className="h-4 w-40" />
                  <Skeleton className="h-3 w-56" />
                </CardContent>
              </Card>
            ))
          : rows.map((row) => {
              const isSelf = row.id === user?.id;
              const isAdmin = row.role === 'admin';

              return (
                <Card key={row.id} className="py-0">
                  <CardContent className="gap-2 p-4">
                    <View className="flex-row items-center gap-2">
                      <View className="flex-1 gap-0.5">
                        <View className="flex-row items-baseline gap-1.5">
                          <Text className="font-semibold leading-tight">
                            {row.fullName || row.email}
                          </Text>
                          <Text variant="muted" className="text-xs">
                            @{row.username}
                          </Text>
                        </View>
                        <Text variant="muted" className="text-xs">
                          {row.email}
                        </Text>
                      </View>
                      <Badge variant={isAdmin ? 'default' : 'secondary'}>
                        <Text>{isAdmin ? 'ADMIN' : 'USER'}</Text>
                      </Badge>
                    </View>

                    <Text variant="muted" className="text-[10px]">
                      Added {formatDateTime(row.createdAt)}
                    </Text>

                    <View className="flex-row gap-2">
                      <Button
                        variant="outline"
                        size="sm"
                        className="flex-1"
                        onPress={() => startEdit(row)}>
                        <PencilSimple size={14} weight="bold" color={primary.hex} />
                        <Text>Edit</Text>
                      </Button>
                      {/* The API refuses this anyway; disabling it says so before the tap. */}
                      <Button
                        variant="outline"
                        size="sm"
                        className="flex-1"
                        disabled={isSelf}
                        onPress={() => setPendingDelete(row)}>
                        <Trash size={14} weight="bold" color={isSelf ? muted : danger} />
                        <Text style={{ color: isSelf ? muted : danger }}>
                          {isSelf ? 'This is you' : 'Delete'}
                        </Text>
                      </Button>
                    </View>
                  </CardContent>
                </Card>
              );
            })}
      </ScrollView>
      </KeyboardAvoidingView>

      <ConfirmModal
        visible={pendingDelete !== null}
        title="Delete account?"
        message={`${pendingDelete?.fullName || pendingDelete?.email} will lose access immediately. This cannot be undone.`}
        confirmLabel="Delete account"
        destructive
        busy={deleting}
        onConfirm={() => void remove()}
        onClose={() => setPendingDelete(null)}
      />
    </SafeAreaView>
  );
}
