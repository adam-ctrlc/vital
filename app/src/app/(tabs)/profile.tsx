import Slider from '@react-native-community/slider';
import { useColorScheme } from 'nativewind';
import At from 'phosphor-react-native/src/icons/At';
import BellRinging from 'phosphor-react-native/src/icons/BellRinging';
import CaretDown from 'phosphor-react-native/src/icons/CaretDown';
import Check from 'phosphor-react-native/src/icons/Check';
import Envelope from 'phosphor-react-native/src/icons/Envelope';
import Eye from 'phosphor-react-native/src/icons/Eye';
import EyeSlash from 'phosphor-react-native/src/icons/EyeSlash';
import IdentificationCard from 'phosphor-react-native/src/icons/IdentificationCard';
import Lock from 'phosphor-react-native/src/icons/Lock';
import MusicNote from 'phosphor-react-native/src/icons/MusicNote';
import PaperPlaneTilt from 'phosphor-react-native/src/icons/PaperPlaneTilt';
import Palette from 'phosphor-react-native/src/icons/Palette';
import PencilSimple from 'phosphor-react-native/src/icons/PencilSimple';
import ShieldCheck from 'phosphor-react-native/src/icons/ShieldCheck';
import SignOut from 'phosphor-react-native/src/icons/SignOut';
import UserCircle from 'phosphor-react-native/src/icons/UserCircle';
import X from 'phosphor-react-native/src/icons/X';
import { useCallback, useEffect, useRef, useState } from 'react';
import { createAudioPlayer } from 'expo-audio';
import {
  KeyboardAvoidingView,
  Linking,
  Platform,
  ScrollView,
  Vibration,
  View,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

import { AppearanceModal } from '@/components/appearance-modal';
import { BottomSheet } from '@/components/bottom-sheet';
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
import {
  MAX_SECONDS,
  MIN_SECONDS,
  STEPS,
  STEP_SECONDS,
  formatDuration,
} from '@/features/notifications/alert-length';
import {
  ALERT_PATTERNS,
  pulseFor,
  type AlertPatternName,
} from '@/features/notifications/alert-pattern';
import { ALERT_SOUNDS, soundFor } from '@/features/notifications/alert-sound';
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
  const muted = colorScheme === 'dark' ? '#a1a1aa' : '#71717a';
  const fg = colorScheme === 'dark' ? '#fafafa' : '#0a0a0a';

  const {
    notificationsEnabled,
    setNotificationsEnabled,
    alertSeconds,
    setAlertSeconds,
    alertPattern,
    setAlertPattern,
    alertSound,
    setAlertSound,
    customSound,
    chooseCustomSound,
    removeCustomSound,
    previewing,
    togglePreview,
    sendTest,
    cancelTest,
  } = useNotifications();
  const [showStyles, setShowStyles] = useState(false);
  const [showSounds, setShowSounds] = useState(false);
  const [pickingSound, setPickingSound] = useState(false);
  const [testing, setTesting] = useState<{ title: string; body: string } | null>(null);
  const [testQueued, setTestQueued] = useState(false);

  async function runTest() {
    setTesting({ title: 'Scheduling', body: 'Asking Android to hold the alert.' });
    const { ok, detail } = await sendTest();

    if (!ok) {
      setTesting(null);
      setTestQueued(false);
      setNotificationsError(detail || 'Could not schedule the test notification.');
      return;
    }

    setNotificationsError(null);
    setTestQueued(true);
    setTesting({ title: 'Close Vital now', body: `The first tone arrives in 5 seconds. ${detail}` });
  }

  async function stopTest() {
    await cancelTest();
    setTestQueued(false);
    setTesting({ title: 'Test stopped', body: 'Nothing else is queued.' });
    setTimeout(() => setTesting(null), 4000);
  }
  // The live value while a drag is in progress. Null when the thumb is not held, so
  // the readout falls back to what is actually stored.
  const [dragSeconds, setDragSeconds] = useState<number | null>(null);

  /**
   * Plays one tone once, so a choice can be heard before it is committed.
   *
   * Its own player rather than the context's: that one loops for the whole alert
   * length, which is not what tapping down a list wants.
   */
  const sample = useRef<ReturnType<typeof createAudioPlayer> | null>(null);

  const releaseSample = useCallback(() => {
    Vibration.cancel();

    const current = sample.current;
    sample.current = null;
    if (!current) return;

    // Same as the preview player: releasing one does not reliably stop it, and the
    // style sample loops, so it has to be halted before it is let go.
    try {
      current.loop = false;
      current.pause();
    } catch {
      // Already stopped, or gone. The release below is what actually matters.
    }

    try {
      current.remove();
    } catch {
      // Already released. Nothing to do, and nothing worth reporting.
    }
  }, []);

  const audition = useCallback(
    (asset: number | null, loop = false) => {
      releaseSample();
      // Only one thing makes noise at a time. The full preview and these samples are
      // separate players, so without this they would talk over each other and stopping
      // one would leave the other going.
      if (previewing) togglePreview();
      if (asset === null || Platform.OS === 'web') return;

      try {
        const created = createAudioPlayer(asset);
        created.loop = loop;
        created.play();
        sample.current = created;
      } catch {
        // Hearing the sample is a convenience; failing at it should change nothing.
      }
    },
    [releaseSample, previewing, togglePreview]
  );

  /**
   * Samples a buzz shape together with the tone that is currently chosen.
   *
   * Both halves, because that is what an alert actually is. Picking a pattern in
   * silence tells you how it feels but not how it lands, and the two interact: a
   * long buzz under a short tone reads very differently from the reverse.
   *
   * Both repeat, so two shapes can be held against each other rather than remembered.
   * It runs until another row is tapped or the sheet is closed, which is what makes
   * comparing possible; a sample that stops on its own has to be retriggered every
   * time attention moves.
   */
  const auditionStyle = useCallback(
    (name: AlertPatternName) => {
      if (Platform.OS === 'web') return;

      // Sound first, and only then the buzz. Starting the tone is what tears down a
      // running preview, and that teardown cancels the vibrator; buzzing first would
      // just have it silenced a line later.
      audition(soundFor(alertSound).asset, true);
      Vibration.vibrate(pulseFor(name), true);
    },
    [releaseSample, audition, alertSound]
  );

  // The sheet can be dismissed mid-sample, and an unreleased player leaks.
  useEffect(() => releaseSample, [releaseSample]);

  async function chooseSound() {
    setPickingSound(true);
    try {
      const ok = await chooseCustomSound();
      setNotificationsError(ok ? null : 'Could not read that file. Try another one.');
    } finally {
      setPickingSound(false);
    }
  }


  const selectedStyle = ALERT_PATTERNS.find((pattern) => pattern.value === alertPattern);
  const selectedSound = ALERT_SOUNDS.find((sound) => sound.value === alertSound);
  const StyleIcon = selectedStyle?.icon;
  const SoundIcon = selectedSound?.icon;

  const [togglingNotifications, setTogglingNotifications] = useState(false);
  // Set when the user asks for notifications and the OS refuses. Only the system
  // settings can undo that, so the card says so rather than letting the switch snap
  // back with no explanation.
  const [notificationsBlocked, setNotificationsBlocked] = useState(false);
  const [notificationsError, setNotificationsError] = useState<string | null>(null);

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

            <View className="border-border gap-2 border-t pt-3">
              <Text className="text-sm font-medium">Alert style</Text>
              <Button
                variant="outline"
                className="h-11 flex-row items-center justify-between"
                disabled={!notificationsEnabled}
                onPress={() => setShowStyles(true)}>
                <View className="flex-row items-center gap-2">
                  {StyleIcon ? <StyleIcon size={16} weight="bold" color={primary.hex} /> : null}
                  <Text>{selectedStyle?.label}</Text>
                </View>
                <CaretDown size={14} weight="bold" color={muted} />
              </Button>
              <Text variant="muted" className="text-xs leading-4">
                {selectedStyle?.description}
              </Text>
            </View>

            <View className="border-border gap-2 border-t pt-3">
              <Text className="text-sm font-medium">Alert sound</Text>
              <Button
                variant="outline"
                className="h-11 flex-row items-center justify-between"
                disabled={!notificationsEnabled}
                onPress={() => setShowSounds(true)}>
                <View className="flex-row items-center gap-2">
                  {SoundIcon ? <SoundIcon size={16} weight="bold" color={primary.hex} /> : null}
                  <Text>{selectedSound?.label}</Text>
                </View>
                <CaretDown size={14} weight="bold" color={muted} />
              </Button>
              <Text variant="muted" className="text-xs leading-4">
                {selectedSound?.description} Plays even when Vital is closed.
              </Text>

              <View className="border-border/60 mt-1 gap-2 border-t pt-3">
                <View className="flex-row items-baseline justify-between">
                  <Text className="text-xs font-medium">Your own file</Text>
                  <Text variant="muted" className="text-[10px]">
                    Optional
                  </Text>
                </View>
                <Text variant="muted" className="text-xs leading-4">
                  Plays instead of the tone above while Vital is open. When Vital is
                  closed, the tone above plays.
                </Text>
              <View className="flex-row items-center gap-2">
                <MusicNote size={14} weight="bold" color={customSound ? primary.hex : muted} />
                <Text variant="muted" className="flex-1 text-xs" numberOfLines={1}>
                  {customSound ? customSound.name : 'No file chosen'}
                </Text>
              </View>
              <View className="flex-row gap-2">
                <Button
                  variant="outline"
                  size="sm"
                  className="flex-1"
                  disabled={!notificationsEnabled || pickingSound}
                  onPress={() => void chooseSound()}>
                  <Text className="text-xs">
                    {pickingSound ? 'Opening...' : customSound ? 'Replace' : 'Choose a file'}
                  </Text>
                </Button>
                {customSound ? (
                  <Button
                    variant="outline"
                    size="sm"
                    className="flex-1"
                    disabled={!notificationsEnabled}
                    onPress={() => void removeCustomSound()}>
                    <Text className="text-xs" style={{ color: danger }}>
                      Remove
                    </Text>
                  </Button>
                ) : null}
              </View>
              </View>
            </View>

            <View className="border-border gap-1 border-t pt-3">
              <View className="flex-row items-baseline justify-between">
                <Text className="text-sm font-medium">Alert length</Text>
                <Text variant="muted" className="text-[10px]">
                  {formatDuration(dragSeconds ?? alertSeconds)}
                </Text>
              </View>
              <Text variant="muted" className="text-xs leading-4">
                How long the phone buzzes for each alert.
              </Text>
              <Slider
                minimumValue={MIN_SECONDS}
                maximumValue={MAX_SECONDS}
                step={STEP_SECONDS}
                value={alertSeconds}
                disabled={!notificationsEnabled}
                minimumTrackTintColor={primary.hex}
                maximumTrackTintColor={muted}
                thumbTintColor={primary.hex}
                // The readout follows every step so the number matches the thumb, but
                // storage is only written on release: one value per drag rather than
                // one per notch crossed.
                onValueChange={(seconds) => setDragSeconds(Math.round(seconds))}
                onSlidingComplete={(seconds) => {
                  setAlertSeconds(Math.round(seconds));
                  setDragSeconds(null);
                }}
              />
              {/* Notches under the track, one per position the thumb can land on, so
                  the step size is visible rather than only felt. Evenly spaced matches
                  the thumb's travel closely enough at this size. */}
              <View className="-mt-1 flex-row justify-between px-2">
                {STEPS.map((seconds) => (
                  <View
                    key={seconds}
                    className="h-1.5 w-px"
                    style={{
                      backgroundColor:
                        seconds <= (dragSeconds ?? alertSeconds) ? primary.hex : muted,
                      opacity: seconds <= (dragSeconds ?? alertSeconds) ? 0.9 : 0.35,
                    }}
                  />
                ))}
              </View>

              <View className="flex-row justify-between">
                <Text variant="muted" className="text-[10px]">
                  {formatDuration(MIN_SECONDS)}
                </Text>
                <Text variant="muted" className="text-[10px]">
                  {formatDuration(MAX_SECONDS)}
                </Text>
              </View>

              {/* Two buttons because there are two paths, and one cannot show the
                  other. Preview runs the real driver in process, which is what an alert
                  does while you are looking at the app. The test schedules a real
                  notification, which is what Android does when you are not: the sound
                  comes off the channel, so it is the only way to hear what a closed app
                  will actually do. */}
              <View className="mt-1 flex-row gap-2">
                <Button
                  variant="outline"
                  size="sm"
                  className="flex-1"
                  disabled={!notificationsEnabled}
                  onPress={() => {
                    // The same the other way round: a sample still ringing would sit
                    // underneath the preview and outlast the stop.
                    releaseSample();
                    togglePreview();
                  }}>
                  {previewing ? (
                    <X size={14} weight="bold" color={danger} />
                  ) : (
                    <BellRinging size={14} weight="bold" color={primary.hex} />
                  )}
                  <Text className="text-xs" style={previewing ? { color: danger } : undefined}>
                    {previewing ? 'Stop preview' : 'Preview'}
                  </Text>
                </Button>

                {/* Turns into a stop once a test is queued. Covering ten minutes means
                    fifty scheduled notifications, and without a way to call them off the
                    only way to end one would be to sit through it. */}
                <Button
                  variant="outline"
                  size="sm"
                  className="flex-1"
                  disabled={!notificationsEnabled}
                  onPress={() => void (testQueued ? stopTest() : runTest())}>
                  {testQueued ? (
                    <X size={14} weight="bold" color={danger} />
                  ) : (
                    <PaperPlaneTilt size={14} weight="bold" color={primary.hex} />
                  )}
                  <Text className="text-xs" style={testQueued ? { color: danger } : undefined}>
                    {testQueued ? 'Stop test' : 'Test closed'}
                  </Text>
                </Button>
              </View>

              {/* Same shape as the temperature warning on the monitor: a tinted panel
                  rather than a line of grey text, because this one is an instruction
                  with a few seconds to act on it. */}
              {testing ? (
                <View
                  className="mt-1 flex-row items-center gap-3 rounded-xl border p-3"
                  style={{
                    borderColor: `${primary.hex}40`,
                    backgroundColor: `${primary.hex}14`,
                  }}>
                  <View
                    className="h-9 w-9 items-center justify-center rounded-full"
                    style={{ backgroundColor: `${primary.hex}26` }}>
                    <PaperPlaneTilt size={18} weight="fill" color={primary.hex} />
                  </View>
                  <View className="flex-1 gap-0.5">
                    <Text className="text-sm font-semibold" style={{ color: primary.hex }}>
                      {testing.title}
                    </Text>
                    <Text variant="muted" className="text-xs leading-4">
                      {testing.body}
                    </Text>
                  </View>
                </View>
              ) : null}
            </View>

            {notificationsError ? (
              <Text className="text-destructive text-xs">{notificationsError}</Text>
            ) : null}

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

      <BottomSheet
        visible={showStyles}
        title="Alert style"
        onClose={() => {
          releaseSample();
          setShowStyles(false);
        }}>
        {ALERT_PATTERNS.map((pattern) => {
          const selected = pattern.value === alertPattern;
          const Icon = pattern.icon;

          return (
            <Button
              key={pattern.value}
              variant={selected ? 'default' : 'outline'}
              className="h-auto flex-row items-center gap-3 py-3"
              onPress={() => {
                setAlertPattern(pattern.value);
                auditionStyle(pattern.value);
              }}>
              <Icon
                size={20}
                weight={selected ? 'fill' : 'regular'}
                color={selected ? ON_PRIMARY : primary.hex}
              />
              <View className="flex-1 gap-0.5">
                <Text
                  className="text-sm font-medium"
                  style={selected ? { color: ON_PRIMARY } : undefined}>
                  {pattern.label}
                </Text>
                <Text
                  className="text-[11px] leading-4"
                  style={{ color: selected ? ON_PRIMARY : muted }}>
                  {pattern.description}
                </Text>
              </View>
            </Button>
          );
        })}
        <Text variant="muted" className="pt-1 text-center text-[11px] leading-4">
          Tap to feel it, with the tone you picked. The sheet stays open so you can
          compare.
        </Text>
      </BottomSheet>

      <BottomSheet
        visible={showSounds}
        title="Alert sound"
        onClose={() => {
          releaseSample();
          setShowSounds(false);
        }}>
        {ALERT_SOUNDS.map((sound) => {
          const selected = sound.value === alertSound;
          const Icon = sound.icon;

          return (
            <Button
              key={sound.value}
              variant={selected ? 'default' : 'outline'}
              className="h-auto flex-row items-center gap-3 py-3"
              onPress={() => {
                setAlertSound(sound.value);
                audition(sound.asset);
              }}>
              <Icon
                size={20}
                weight={selected ? 'fill' : 'regular'}
                color={selected ? ON_PRIMARY : primary.hex}
              />
              <View className="flex-1 gap-0.5">
                <Text
                  className="text-sm font-medium"
                  style={selected ? { color: ON_PRIMARY } : undefined}>
                  {sound.label}
                </Text>
                <Text
                  className="text-[11px] leading-4"
                  style={{ color: selected ? ON_PRIMARY : muted }}>
                  {sound.description}
                </Text>
              </View>
            </Button>
          );
        })}
        <Text variant="muted" className="pt-1 text-center text-[11px] leading-4">
          Tap to hear it. The sheet stays open so you can compare.
        </Text>
      </BottomSheet>

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
