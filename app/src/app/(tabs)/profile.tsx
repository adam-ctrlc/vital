import { useColorScheme } from 'nativewind';
import At from 'phosphor-react-native/src/icons/At';
import BellRinging from 'phosphor-react-native/src/icons/BellRinging';
import Check from 'phosphor-react-native/src/icons/Check';
import Envelope from 'phosphor-react-native/src/icons/Envelope';
import Eye from 'phosphor-react-native/src/icons/Eye';
import EyeSlash from 'phosphor-react-native/src/icons/EyeSlash';
import IdentificationCard from 'phosphor-react-native/src/icons/IdentificationCard';
import Lock from 'phosphor-react-native/src/icons/Lock';
import Palette from 'phosphor-react-native/src/icons/Palette';
import PencilSimple from 'phosphor-react-native/src/icons/PencilSimple';
import ShieldCheck from 'phosphor-react-native/src/icons/ShieldCheck';
import SignOut from 'phosphor-react-native/src/icons/SignOut';
import UserCircle from 'phosphor-react-native/src/icons/UserCircle';
import X from 'phosphor-react-native/src/icons/X';
import { useState } from 'react';
import { KeyboardAvoidingView, Linking, ScrollView, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

import { AppearanceModal } from '@/components/appearance-modal';
import { ConfirmModal } from '@/components/confirm-modal';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { IconInput } from '@/components/ui/icon-input';
import { Switch } from '@/components/ui/switch';
import { Text } from '@/components/ui/text';
import * as authApi from '@/features/auth/api';
import { useAuth } from '@/features/auth/context';
import type { Role, User } from '@/features/auth/types';
import { useNotifications } from '@/features/notifications/context';
import { useAppearance } from '@/lib/appearance';

/** Matches `--primary-foreground`, which the appearance provider pins to white. */
const ON_PRIMARY = '#ffffff';

/** What each role is allowed to reach, so the badge is not just a label. */
function roleSummary(role: Role | undefined): string {
  switch (role) {
    case 'admin':
      return 'Maintenance Engineer. Full access, including thresholds, logs and accounts.';
    case 'user':
      return 'Power Utility Personnel. Real-time monitoring and alerts.';
    default:
      return 'Signed out.';
  }
}

/**
 * Initials from the name, falling back to the username so the avatar is never blank.
 * The username rather than the email, because an account may have no email at all.
 */
function initials(first: string | undefined, last: string | undefined, username: string | undefined) {
  const letters = `${first?.[0] ?? ''}${last?.[0] ?? ''}`.trim();
  if (letters) return letters.toUpperCase();

  return (username?.[0] ?? '?').toUpperCase();
}

/** A labelled row. The hint carries why a field is read-only, or that it is optional. */
function Field({
  label,
  hint,
  children,
}: {
  label: string;
  hint?: string;
  children: React.ReactNode;
}) {
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

type NameDraft = {
  firstName: string;
  middleName: string;
  lastName: string;
  email: string;
  username: string;
};

function draftOf(user: User | null): NameDraft {
  return {
    firstName: user?.firstName ?? '',
    middleName: user?.middleName ?? '',
    lastName: user?.lastName ?? '',
    email: user?.email ?? '',
    username: user?.username ?? '',
  };
}

/**
 * Kept apart from the name form: changing a password needs the current one, and
 * mixing that into the same Save would make an innocuous rename ask for it too.
 */
function PasswordCard() {
  const { token } = useAuth();
  const { primary } = useAppearance();
  const { colorScheme } = useColorScheme();
  const isDark = colorScheme === 'dark';
  const danger = isDark ? '#f87171' : '#dc2626';

  const [open, setOpen] = useState(false);
  const [currentPassword, setCurrentPassword] = useState('');
  const [newPassword, setNewPassword] = useState('');
  const [reveal, setReveal] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [status, setStatus] = useState<string | null>(null);

  function close() {
    setOpen(false);
    setCurrentPassword('');
    setNewPassword('');
    setReveal(false);
    setError(null);
  }

  async function submit() {
    setBusy(true);
    setError(null);
    setStatus(null);
    try {
      await authApi.changePassword(token ?? '', currentPassword, newPassword);
      close();
      setStatus('Password changed');
    } catch (caught) {
      setError((caught as Error).message);
    } finally {
      setBusy(false);
    }
  }

  const canSubmit = currentPassword.length > 0 && newPassword.length >= 8 && !busy;

  return (
    <Card className="gap-0 py-0">
      <CardHeader className="border-border flex-row items-center justify-between border-b p-4">
        <View className="flex-1 gap-0.5">
          <CardTitle className="text-base">Password</CardTitle>
          <Text variant="muted" className="text-xs">
            You will stay signed in on this device.
          </Text>
        </View>
        {open ? null : (
          <Button variant="outline" size="sm" onPress={() => setOpen(true)}>
            <Lock size={14} weight="bold" color={primary.hex} />
            <Text>Change</Text>
          </Button>
        )}
      </CardHeader>

      {/* Same shape in both modes, like the Account card: the fields are always
          shown and Change only un-disables them. */}
      <CardContent className="gap-4 p-4">
        <Field label="Current password">
          <IconInput
            icon={Lock}
            iconColor={primary.hex}
            value={currentPassword}
            onChangeText={setCurrentPassword}
            editable={open}
            secureTextEntry={!reveal}
            autoCapitalize="none"
            autoCorrect={false}
            placeholder="Your current password"
            action={{
              icon: reveal ? EyeSlash : Eye,
              label: reveal ? 'Hide passwords' : 'Show passwords',
              onPress: () => setReveal((v) => !v),
            }}
          />
        </Field>

        <Field label="New password" hint="8 characters or more">
          <IconInput
            icon={Lock}
            iconColor={primary.hex}
            value={newPassword}
            onChangeText={setNewPassword}
            editable={open}
            secureTextEntry={!reveal}
            autoCapitalize="none"
            autoCorrect={false}
            placeholder="Your new password"
          />
        </Field>

        {error ? <Text className="text-destructive text-sm">{error}</Text> : null}
        {status && !open ? <Text className="text-primary text-sm">{status}</Text> : null}

        {open ? (
          <View className="flex-row gap-2">
            <Button variant="outline" className="flex-1" disabled={busy} onPress={close}>
              <X size={14} weight="bold" color={danger} />
              <Text>Cancel</Text>
            </Button>
            {/* Kept short on purpose: the card is already titled Password, and a
                longer label wraps inside a half-width button and stops centring. */}
            <Button className="flex-1" disabled={!canSubmit} onPress={() => void submit()}>
              <Check size={14} weight="bold" color={ON_PRIMARY} />
              <Text numberOfLines={1}>{busy ? 'Saving...' : 'Save'}</Text>
            </Button>
          </View>
        ) : null}
      </CardContent>
    </Card>
  );
}

export default function ProfileScreen() {
  const { token, user, signOut, setUser } = useAuth();
  const { primary } = useAppearance();
  const { colorScheme } = useColorScheme();
  const danger = colorScheme === 'dark' ? '#f87171' : '#dc2626';

  const { notificationsEnabled, setNotificationsEnabled } = useNotifications();
  const [togglingNotifications, setTogglingNotifications] = useState(false);
  // Set when the user asks for notifications and the OS refuses. Only the system
  // settings can undo that, so the card says so rather than letting the switch snap
  // back with no explanation.
  const [notificationsBlocked, setNotificationsBlocked] = useState(false);

  async function toggleNotifications(next: boolean) {
    setTogglingNotifications(true);
    try {
      const applied = await setNotificationsEnabled(next);
      setNotificationsBlocked(next && !applied);
    } finally {
      setTogglingNotifications(false);
    }
  }

  const [showAppearance, setShowAppearance] = useState(false);
  const [showSignOut, setShowSignOut] = useState(false);
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState<NameDraft>(draftOf(user));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [status, setStatus] = useState<string | null>(null);

  const isAdmin = user?.role === 'admin';
  const current = draftOf(user);
  const dirty =
    draft.firstName !== current.firstName ||
    draft.middleName !== current.middleName ||
    draft.lastName !== current.lastName ||
    (isAdmin && (draft.email !== current.email || draft.username !== current.username));

  // Admins may edit the login identity, so it has to pass the same shape checks the
  // server applies. Non-admins never send these, so they are always valid here.
  const identityValid =
    !isAdmin ||
    ((draft.email.trim() === '' || draft.email.trim().includes('@')) &&
      draft.username.trim().length > 0);

  function startEditing() {
    setDraft(draftOf(user));
    setError(null);
    setStatus(null);
    setEditing(true);
  }

  function cancel() {
    setDraft(draftOf(user));
    setEditing(false);
    setError(null);
  }

  async function save() {
    setBusy(true);
    setError(null);
    try {
      const updated = await authApi.updateProfile(token ?? '', {
        firstName: draft.firstName.trim(),
        middleName: draft.middleName.trim() || null,
        lastName: draft.lastName.trim(),
        // Only admins may change these; non-admins would get a 403, so leave them off.
        ...(isAdmin ? { email: draft.email.trim(), username: draft.username.trim() } : {}),
      });
      // The header and greeting read from context, so they follow immediately.
      setUser(updated);
      setEditing(false);
      setStatus('Account updated');
    } catch (caught) {
      setError((caught as Error).message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <SafeAreaView className="bg-background flex-1" edges={['top']}>
      <KeyboardAvoidingView className="flex-1" behavior="padding">
      <ScrollView
        contentContainerClassName="gap-4 p-4 pb-8"
        keyboardShouldPersistTaps="handled"
        keyboardDismissMode="on-drag">
        <View className="flex-row items-center gap-2">
          <UserCircle size={22} weight="fill" color={primary.hex} />
          <Text className="text-lg font-bold">Profile</Text>
        </View>

        <Card className="py-0">
          <CardContent className="items-center gap-3 p-5">
            <View
              className="h-20 w-20 items-center justify-center rounded-full"
              style={{ backgroundColor: `${primary.hex}22` }}>
              <Text className="text-2xl font-bold" style={{ color: primary.hex }}>
                {initials(user?.firstName, user?.lastName, user?.username)}
              </Text>
            </View>

            <View className="items-center gap-1">
              <Text className="text-xl font-bold">{user?.fullName || user?.email || '--'}</Text>
              <Badge variant={isAdmin ? 'default' : 'secondary'}>
                <Text>{isAdmin ? 'ADMIN' : 'USER'}</Text>
              </Badge>
            </View>

            <Text variant="muted" className="text-center text-xs">
              {roleSummary(user?.role)}
            </Text>
          </CardContent>
        </Card>

        <Card className="gap-0 py-0">
          <CardHeader className="border-border flex-row items-center justify-between border-b p-4">
            <CardTitle className="text-base">Account</CardTitle>
            {editing ? null : (
              <Button variant="outline" size="sm" onPress={startEditing}>
                <PencilSimple size={14} weight="bold" color={primary.hex} />
                <Text>Edit</Text>
              </Button>
            )}
          </CardHeader>
          {/* The layout does not change between modes: the same fields are always
              shown, and editing only un-disables the ones you may change. Email is
              the login identity and access level is an admin decision, so both stay
              read-only throughout. */}
          <CardContent className="gap-4 p-4">
            <Field label="Email" hint={isAdmin ? 'Used to sign in' : 'Not editable'}>
              <IconInput
                icon={Envelope}
                iconColor={primary.hex}
                value={isAdmin ? draft.email : (user?.email ?? '')}
                onChangeText={
                  isAdmin ? (email) => setDraft((prev) => ({ ...prev, email })) : undefined
                }
                editable={isAdmin && editing}
                autoCapitalize="none"
                autoCorrect={false}
                keyboardType="email-address"
                placeholder="you@example.com"
              />
            </Field>

            <Field label="Username" hint={isAdmin ? 'Used to sign in' : 'Not editable'}>
              <IconInput
                icon={At}
                iconColor={primary.hex}
                value={isAdmin ? draft.username : (user?.username ?? '')}
                onChangeText={
                  isAdmin
                    ? (username) => setDraft((prev) => ({ ...prev, username: username.toLowerCase() }))
                    : undefined
                }
                editable={isAdmin && editing}
                autoCapitalize="none"
                autoCorrect={false}
                placeholder="username"
              />
            </Field>

            <Field label="First name">
              <IconInput
                icon={IdentificationCard}
                iconColor={primary.hex}
                value={draft.firstName}
                onChangeText={(firstName) => setDraft((prev) => ({ ...prev, firstName }))}
                editable={editing}
                placeholder="Maria"
              />
            </Field>

            <Field label="Middle name" hint="Optional">
              <IconInput
                icon={IdentificationCard}
                iconColor={primary.hex}
                value={draft.middleName}
                onChangeText={(middleName) => setDraft((prev) => ({ ...prev, middleName }))}
                editable={editing}
                placeholder="Luisa"
              />
            </Field>

            <Field label="Last name">
              <IconInput
                icon={IdentificationCard}
                iconColor={primary.hex}
                value={draft.lastName}
                onChangeText={(lastName) => setDraft((prev) => ({ ...prev, lastName }))}
                editable={editing}
                placeholder="Santos"
              />
            </Field>

            <Field label="Access level" hint="Set by an admin">
              <IconInput
                icon={ShieldCheck}
                iconColor={primary.hex}
                value={isAdmin ? 'Administrator' : 'Standard user'}
                editable={false}
              />
            </Field>

            {error ? <Text className="text-destructive text-sm">{error}</Text> : null}
            {status && !editing ? <Text className="text-primary text-sm">{status}</Text> : null}

            {editing ? (
              <View className="flex-row gap-2">
                <Button variant="outline" className="flex-1" disabled={busy} onPress={cancel}>
                  <X size={14} weight="bold" color={danger} />
                  <Text>Cancel</Text>
                </Button>
                <Button
                  className="flex-1"
                  disabled={busy || !dirty || !identityValid}
                  onPress={() => void save()}>
                  <Check size={14} weight="bold" color={ON_PRIMARY} />
                  <Text>{busy ? 'Saving...' : 'Save changes'}</Text>
                </Button>
              </View>
            ) : null}
          </CardContent>
        </Card>

        <PasswordCard />

        <Card className="gap-0 py-0">
          <CardHeader className="border-border border-b p-4">
            <CardTitle className="text-base">Notifications</CardTitle>
            <Text variant="muted" className="text-xs">
              Applies to this device only.
            </Text>
          </CardHeader>
          <CardContent className="gap-3 p-4">
            <View className="flex-row items-center justify-between gap-3">
              <View className="flex-1 gap-0.5">
                <Text className="text-sm font-medium">Alert notifications</Text>
                <Text variant="muted" className="text-xs leading-4">
                  Buzz and show a banner when an alert is raised. The Alerts tab and its
                  badge keep working either way.
                </Text>
              </View>
              <Switch
                checked={notificationsEnabled}
                disabled={togglingNotifications}
                onCheckedChange={(next) => void toggleNotifications(next)}
              />
            </View>

            {notificationsBlocked ? (
              <View className="gap-2">
                <Text className="text-destructive text-xs leading-4">
                  Android is refusing notifications for VITAL. The app cannot ask again once
                  that has been set, so it has to be changed in system settings.
                </Text>
                <Button variant="outline" size="sm" onPress={() => void Linking.openSettings()}>
                  <BellRinging size={14} weight="bold" color={primary.hex} />
                  <Text className="text-xs">Open system settings</Text>
                </Button>
              </View>
            ) : null}
          </CardContent>
        </Card>

        <Card className="gap-0 py-0">
          <CardHeader className="border-border border-b p-4">
            <CardTitle className="text-base">Appearance</CardTitle>
            <Text variant="muted" className="text-xs">
              Colors and theme apply to this device only.
            </Text>
          </CardHeader>
          <CardContent className="p-4">
            <Button variant="outline" onPress={() => setShowAppearance(true)}>
              <Palette size={16} weight="bold" color={primary.hex} />
              <Text>Customize appearance</Text>
            </Button>
          </CardContent>
        </Card>

        <Button variant="outline" onPress={() => setShowSignOut(true)}>
          <SignOut size={16} weight="bold" color={danger} />
          <Text style={{ color: danger }}>Sign out</Text>
        </Button>

        <Text variant="muted" className="text-center text-[10px]">
          VITAL, PHINMA Cagayan de Oro College
        </Text>
      </ScrollView>
      </KeyboardAvoidingView>

      <AppearanceModal visible={showAppearance} onClose={() => setShowAppearance(false)} />
      <ConfirmModal
        visible={showSignOut}
        title="Sign out?"
        message="You will need your email and password to sign back in."
        confirmLabel="Sign out"
        destructive
        onConfirm={() => {
          setShowSignOut(false);
          void signOut();
        }}
        onClose={() => setShowSignOut(false)}
      />
    </SafeAreaView>
  );
}
