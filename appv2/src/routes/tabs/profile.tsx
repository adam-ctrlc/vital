import {
  AtIcon,
  BellIcon,
  BellRingingIcon,
  CaretRightIcon,
  CheckIcon,
  EnvelopeIcon,
  IdentificationCardIcon,
  InfoIcon,
  LockIcon,
  MusicNoteIcon,
  PaletteIcon,
  PaperPlaneTiltIcon,
  PencilSimpleIcon,
  ShieldCheckIcon,
  SignOutIcon,
  TimerIcon,
  UserCircleIcon,
  XIcon,
  type Icon,
} from '@phosphor-icons/react';
import { Fragment, useCallback, useEffect, useRef, useState, type ReactNode } from 'react';

import { AppearanceModal } from '@/components/appearance-modal';
import { BottomSheet } from '@/components/bottom-sheet';
import { ConfirmModal } from '@/components/confirm-modal';
import { InfoModal } from '@/components/info-modal';
import { EditProfileSheet, PasswordSheet } from '@/components/profile/account-sheets';
import { Button } from '@/components/ui/button';
import { Callout, type CalloutTone } from '@/components/ui/callout';
import { Card } from '@/components/ui/card';
import { PageHeader } from '@/components/ui/page-header';
import { SettingsRow, SettingsSection } from '@/components/ui/settings-list';
import { Slider } from '@/components/ui/slider';
import { Switch } from '@/components/ui/switch';
import { useAuth } from '@/features/auth/context';
import type { Role } from '@/features/auth/types';
import {
  MAX_SECONDS,
  MIN_SECONDS,
  STEPS,
  STEP_SECONDS,
  formatDuration,
} from '@/features/notifications/alert-length';
import { ALERT_PATTERNS, pulseFor, type AlertPatternName } from '@/features/notifications/alert-pattern';
import { ALERT_SOUNDS, soundFor } from '@/features/notifications/alert-sound';
import { useNotifications } from '@/features/notifications/context';
import { playSound, releaseSound } from '@/features/notifications/player';
import { cancelVibration, vibrate } from '@/features/notifications/vibration';
import { useAppearance } from '@/lib/appearance';
import { IS_NATIVE } from '@/lib/platform';
import { cn } from '@/lib/utils';

/** How long a confirmation such as "Password changed" stays up. */
const NOTICE_MS = 4000;

const ROLE_TITLE: Record<Role, string> = {
  admin: 'Maintenance Engineer',
  user: 'Power Utility Personnel',
};

/**
 * Initials from the name, falling back to the username so the avatar is never blank.
 * The username rather than the email, because an account may have no email at all.
 */
function initials(first: string | undefined, last: string | undefined, username: string | undefined) {
  const letters = `${first?.[0] ?? ''}${last?.[0] ?? ''}`.trim();
  if (letters) return letters.toUpperCase();

  return (username?.[0] ?? '?').toUpperCase();
}

type Notice = { tone: CalloutTone; title: string; description?: ReactNode };

/** One choice in a picker sheet: icon, label, a line under it, and a check when chosen. */
function OptionList<T extends string>({
  options,
  value,
  onSelect,
}: {
  options: { value: T; label: string; description: string; icon: Icon }[];
  value: T;
  onSelect: (value: T) => void;
}) {
  const { primary } = useAppearance();

  return (
    <div role="radiogroup" className="-mx-2 flex flex-col gap-0.5">
      {options.map((option) => {
        const selected = option.value === value;
        const OptionIcon = option.icon;

        return (
          <button
            key={option.value}
            type="button"
            role="radio"
            aria-checked={selected}
            onClick={() => onSelect(option.value)}
            className={cn(
              'flex w-full cursor-pointer items-center gap-3 rounded-lg px-3 py-2.5 text-left transition-colors',
              selected ? 'bg-accent' : 'hover:bg-accent/60'
            )}>
            <OptionIcon size={20} weight={selected ? 'fill' : 'regular'} color={primary.hex} aria-hidden="true" />
            <span className="min-w-0 flex-1">
              <span className="block text-sm font-medium">{option.label}</span>
              <span className="text-muted-foreground block text-xs">{option.description}</span>
            </span>
            {selected ? <CheckIcon size={16} weight="bold" color={primary.hex} aria-hidden="true" /> : null}
          </button>
        );
      })}
    </div>
  );
}

/** "Allow them in Settings > Apps > …", with caret icons between the steps. */
function SettingsPath({ steps }: { steps: string[] }) {
  return (
    <span className="inline-flex flex-wrap items-center gap-x-1">
      Allow them in
      {steps.map((step, index) => (
        <Fragment key={step}>
          {index > 0 ? <CaretRightIcon size={10} weight="bold" aria-label="then" /> : null}
          <span className="font-medium">{step}</span>
        </Fragment>
      ))}
    </span>
  );
}

export default function ProfileScreen() {
  const { user, signOut } = useAuth();
  const { primary } = useAppearance();
  const isAdmin = user?.role === 'admin';

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

  const [sheet, setSheet] = useState<
    'profile' | 'password' | 'style' | 'sound' | 'file' | 'length' | 'appearance' | 'help' | 'signOut' | null
  >(null);
  const close = useCallback(() => setSheet(null), []);

  const [accountNotice, setAccountNotice] = useState<Notice | null>(null);
  const [notificationsNotice, setNotificationsNotice] = useState<Notice | null>(null);
  // Set when the user asks for notifications and the OS refuses. Only the system settings
  // can undo that, so the section says so rather than letting the switch snap back.
  const [notificationsBlocked, setNotificationsBlocked] = useState(false);
  const [togglingNotifications, setTogglingNotifications] = useState(false);
  const [pickingSound, setPickingSound] = useState(false);
  const [testQueued, setTestQueued] = useState(false);
  const [lengthDraft, setLengthDraft] = useState(alertSeconds);

  // Confirmations clear themselves; errors stay until something else replaces them.
  useEffect(() => {
    if (accountNotice?.tone !== 'success') return;
    const timer = setTimeout(() => setAccountNotice(null), NOTICE_MS);
    return () => clearTimeout(timer);
  }, [accountNotice]);

  async function toggleNotifications(next: boolean) {
    setTogglingNotifications(true);
    try {
      const applied = await setNotificationsEnabled(next);
      setNotificationsBlocked(next && !applied);
    } finally {
      setTogglingNotifications(false);
    }
  }

  async function runTest() {
    setNotificationsNotice({
      tone: 'info',
      title: 'Scheduling',
      description: IS_NATIVE ? 'Asking Android to hold the alert.' : 'Setting up the test in this tab.',
    });
    const { ok, detail } = await sendTest();

    if (!ok) {
      setTestQueued(false);
      setNotificationsNotice({
        tone: 'destructive',
        title: 'Could not schedule the test',
        description: detail || undefined,
      });
      return;
    }

    setTestQueued(true);
    // A browser cannot play anything once the page is gone, so there the test is heard
    // with the tab left open in the background rather than with the app closed.
    setNotificationsNotice({
      tone: 'info',
      title: IS_NATIVE ? 'Close Vital now' : 'Switch to another tab',
      description: `The first tone arrives in 5 seconds. ${detail}`,
    });
  }

  async function stopTest() {
    await cancelTest();
    setTestQueued(false);
    setNotificationsNotice({ tone: 'success', title: 'Test stopped', description: 'Nothing else is queued.' });
    setTimeout(() => setNotificationsNotice(null), NOTICE_MS);
  }

  /**
   * Plays one tone once, so a choice can be heard before it is committed. Its own player
   * rather than the context's: that one loops for the whole alert length, which is not
   * what tapping down a list wants.
   */
  const sample = useRef<HTMLAudioElement | null>(null);

  const releaseSample = useCallback(() => {
    cancelVibration();
    // The style sample loops, so it has to be halted before it is let go.
    releaseSound(sample.current);
    sample.current = null;
  }, []);

  const audition = useCallback(
    (asset: string | null, loop = false) => {
      releaseSample();
      // Only one thing makes noise at a time: the full preview and these samples are
      // separate players, so without this they would talk over each other.
      if (previewing) togglePreview();
      if (asset === null) return;

      // Hearing the sample is a convenience; failing at it should change nothing.
      sample.current = playSound(asset, loop);
    },
    [releaseSample, previewing, togglePreview]
  );

  /**
   * Samples a buzz shape together with the chosen tone, because that is what an alert
   * is. Both repeat until another row is tapped or the sheet closes, so two shapes can
   * be held against each other rather than remembered.
   */
  const auditionStyle = useCallback(
    (name: AlertPatternName) => {
      // Sound first: starting the tone tears down a running preview, and that teardown
      // cancels the vibrator, so buzzing first would just be silenced a line later.
      audition(soundFor(alertSound).asset, true);
      vibrate(pulseFor(name), true);
    },
    [audition, alertSound]
  );

  // The sheet can be dismissed mid-sample, and an unreleased player leaks.
  useEffect(() => releaseSample, [releaseSample]);

  const closePicker = useCallback(() => {
    releaseSample();
    setSheet(null);
  }, [releaseSample]);

  async function chooseSound() {
    setPickingSound(true);
    try {
      const ok = await chooseCustomSound();
      if (!ok) {
        setNotificationsNotice({ tone: 'destructive', title: 'Could not read that file', description: 'Try another one.' });
      }
    } finally {
      setPickingSound(false);
    }
  }

  const selectedStyle = ALERT_PATTERNS.find((pattern) => pattern.value === alertPattern);
  const selectedSound = ALERT_SOUNDS.find((sound) => sound.value === alertSound);
  const off = !notificationsEnabled;

  const blockedNotice: Notice | null = notificationsBlocked
    ? {
        tone: 'destructive',
        title: 'Notifications are blocked',
        description: IS_NATIVE ? (
          <SettingsPath steps={['Settings', 'Apps', 'Vital', 'Notifications']} />
        ) : (
          'Allow them in the site settings next to the address bar.'
        ),
      }
    : null;
  const shownNotice = blockedNotice ?? notificationsNotice;

  return (
    <>
      <PageHeader icon={UserCircleIcon} iconColor={primary.hex} title="Profile" />

      <Card className="flex-row items-center gap-4 p-4">
        <span
          aria-hidden="true"
          className="grid size-14 shrink-0 place-items-center rounded-full text-lg font-bold"
          style={{ backgroundColor: `${primary.hex}1f`, color: primary.hex }}>
          {initials(user?.firstName, user?.lastName, user?.username)}
        </span>
        <div className="min-w-0 flex-1">
          <h2 className="text-base font-bold leading-tight">{user?.fullName || user?.username || '--'}</h2>
          <p className="text-muted-foreground break-words text-xs">
            @{user?.username} · {user ? ROLE_TITLE[user.role] : ''}
          </p>
        </div>
        <Button variant="outline" size="sm" onClick={() => setSheet('profile')}>
          <PencilSimpleIcon weight="bold" aria-hidden="true" />
          Edit
        </Button>
      </Card>

      {accountNotice ? (
        <Callout tone={accountNotice.tone} title={accountNotice.title} description={accountNotice.description} />
      ) : null}

      <SettingsSection title="Account">
        <SettingsRow
          icon={IdentificationCardIcon}
          iconColor={primary.hex}
          label="Name"
          value={user?.fullName || '--'}
          onClick={() => setSheet('profile')}
        />
        {/* Only an admin may change the sign-in identity, so for a user these are plain
            rows with nothing to open. */}
        <SettingsRow
          icon={AtIcon}
          iconColor={primary.hex}
          label="Username"
          value={user ? `@${user.username}` : '--'}
          onClick={isAdmin ? () => setSheet('profile') : undefined}
        />
        <SettingsRow
          icon={EnvelopeIcon}
          iconColor={primary.hex}
          label="Email"
          value={user?.email ?? 'Not set'}
          onClick={isAdmin ? () => setSheet('profile') : undefined}
        />
        <SettingsRow
          icon={ShieldCheckIcon}
          iconColor={primary.hex}
          label="Access level"
          value={isAdmin ? 'Administrator' : 'Standard user'}
        />
      </SettingsSection>

      <SettingsSection title="Security">
        <SettingsRow
          icon={LockIcon}
          iconColor={primary.hex}
          label="Change password"
          onClick={() => setSheet('password')}
        />
      </SettingsSection>

      <SettingsSection title="Notifications" footer="Applies to this device only.">
        <SettingsRow
          icon={BellIcon}
          iconColor={primary.hex}
          label="Alert notifications"
          trailing={
            <Switch
              aria-label="Alert notifications"
              checked={notificationsEnabled}
              disabled={togglingNotifications}
              onCheckedChange={(next) => void toggleNotifications(next)}
            />
          }
        />
        <SettingsRow
          icon={selectedStyle?.icon}
          iconColor={primary.hex}
          label="Alert style"
          value={selectedStyle?.label}
          disabled={off}
          onClick={() => setSheet('style')}
        />
        <SettingsRow
          icon={selectedSound?.icon}
          iconColor={primary.hex}
          label="Alert sound"
          value={selectedSound?.label}
          disabled={off}
          onClick={() => setSheet('sound')}
        />
        <SettingsRow
          icon={MusicNoteIcon}
          iconColor={primary.hex}
          label="Your own sound"
          value={customSound ? customSound.name : 'None'}
          disabled={off}
          onClick={() => setSheet('file')}
        />
        <SettingsRow
          icon={TimerIcon}
          iconColor={primary.hex}
          label="Alert length"
          value={formatDuration(alertSeconds)}
          disabled={off}
          onClick={() => {
            setLengthDraft(alertSeconds);
            setSheet('length');
          }}
        />

        <div className="space-y-3 p-4">
          {/* Two buttons because there are two paths, and one cannot show the other.
              Preview runs the alert in the page, which is what happens while you are
              looking at the app. The test schedules a real notification, the only way to
              hear what arrives when you are not. */}
          <div className="flex gap-2">
            <Button
              variant="outline"
              className={cn('flex-1', previewing && 'text-destructive')}
              disabled={off}
              onClick={() => {
                // A sample still ringing would sit underneath the preview and outlast it.
                releaseSample();
                togglePreview();
              }}>
              {previewing ? (
                <XIcon weight="bold" aria-hidden="true" />
              ) : (
                <BellRingingIcon weight="bold" color={primary.hex} aria-hidden="true" />
              )}
              {previewing ? 'Stop preview' : 'Preview'}
            </Button>

            {/* Turns into a stop once a test is queued: covering ten minutes means fifty
                scheduled notifications, and nobody should have to sit through them. */}
            <Button
              variant="outline"
              className={cn('flex-1', testQueued && 'text-destructive')}
              disabled={off}
              onClick={() => void (testQueued ? stopTest() : runTest())}>
              {testQueued ? (
                <XIcon weight="bold" aria-hidden="true" />
              ) : (
                <PaperPlaneTiltIcon weight="bold" color={primary.hex} aria-hidden="true" />
              )}
              {testQueued ? 'Stop test' : 'Test closed'}
            </Button>
          </div>

          {shownNotice ? (
            <Callout tone={shownNotice.tone} title={shownNotice.title} description={shownNotice.description} />
          ) : null}
        </div>
      </SettingsSection>

      <SettingsSection title="App">
        <SettingsRow
          icon={PaletteIcon}
          iconColor={primary.hex}
          label="Appearance"
          onClick={() => setSheet('appearance')}
        />
        <SettingsRow icon={InfoIcon} iconColor={primary.hex} label="How it works" onClick={() => setSheet('help')} />
      </SettingsSection>

      <Button variant="outline" className="text-destructive hover:text-destructive" onClick={() => setSheet('signOut')}>
        <SignOutIcon weight="bold" aria-hidden="true" />
        Sign out
      </Button>

      <p className="text-muted-foreground text-center text-[10px]">VITAL, PHINMA Cagayan de Oro College</p>

      <EditProfileSheet
        visible={sheet === 'profile'}
        onClose={close}
        onSaved={() => setAccountNotice({ tone: 'success', title: 'Profile updated' })}
      />
      <PasswordSheet
        visible={sheet === 'password'}
        onClose={close}
        onSaved={() => setAccountNotice({ tone: 'success', title: 'Password changed' })}
      />

      <BottomSheet visible={sheet === 'style'} title="Alert style" onClose={closePicker}>
        <OptionList
          options={ALERT_PATTERNS}
          value={alertPattern}
          onSelect={(name) => {
            setAlertPattern(name);
            auditionStyle(name);
          }}
        />
        <p className="text-muted-foreground text-center text-xs">Tap to feel it with your tone.</p>
      </BottomSheet>

      <BottomSheet visible={sheet === 'sound'} title="Alert sound" onClose={closePicker}>
        <OptionList
          options={ALERT_SOUNDS}
          value={alertSound}
          onSelect={(name) => {
            setAlertSound(name);
            audition(soundFor(name).asset);
          }}
        />
        <p className="text-muted-foreground text-center text-xs">Tap to hear it.</p>
      </BottomSheet>

      <BottomSheet visible={sheet === 'file'} title="Your own sound" onClose={close}>
        <div className="bg-muted/60 flex items-center gap-3 rounded-xl p-4">
          <span className="bg-background grid size-10 shrink-0 place-items-center rounded-lg">
            <MusicNoteIcon size={20} weight="bold" color={primary.hex} aria-hidden="true" />
          </span>
          <div className="min-w-0 flex-1">
            <p className="truncate text-sm font-medium">{customSound ? customSound.name : 'No file chosen'}</p>
            <p className="text-muted-foreground text-xs">Plays only while Vital is open.</p>
          </div>
        </div>
        <div className="flex gap-2">
          {customSound ? (
            <Button
              variant="outline"
              className="text-destructive hover:text-destructive flex-1"
              onClick={() => void removeCustomSound()}>
              Remove
            </Button>
          ) : null}
          <Button className="flex-1" disabled={pickingSound} onClick={() => void chooseSound()}>
            {pickingSound ? 'Opening...' : customSound ? 'Replace' : 'Choose a file'}
          </Button>
        </div>
      </BottomSheet>

      <BottomSheet visible={sheet === 'length'} title="Alert length" onClose={close}>
        <div className="space-y-1 pt-2 text-center">
          <p className="text-3xl font-bold tabular-nums" style={{ color: primary.hex }}>
            {formatDuration(lengthDraft)}
          </p>
          <p className="text-muted-foreground text-xs">How long each alert buzzes.</p>
        </div>
        <div className="space-y-1">
          <Slider
            aria-label="Alert length"
            min={MIN_SECONDS}
            max={MAX_SECONDS}
            step={STEP_SECONDS}
            value={lengthDraft}
            color={primary.hex}
            onValueChange={(seconds) => setLengthDraft(Math.round(seconds))}
          />
          {/* One notch per position the thumb can land on, so the step is visible. */}
          <div className="flex justify-between px-2" aria-hidden="true">
            {STEPS.map((seconds) => (
              <span
                key={seconds}
                className={cn('h-1.5 w-px', seconds > lengthDraft && 'bg-muted-foreground opacity-[0.35]')}
                style={seconds <= lengthDraft ? { backgroundColor: primary.hex } : undefined}
              />
            ))}
          </div>
          <p className="text-muted-foreground flex justify-between text-[11px]">
            <span>{formatDuration(MIN_SECONDS)}</span>
            <span>{formatDuration(MAX_SECONDS)}</span>
          </p>
        </div>
        <div className="flex gap-2">
          <Button variant="outline" className="flex-1" onClick={close}>
            Cancel
          </Button>
          <Button
            className="flex-1"
            disabled={lengthDraft === alertSeconds}
            onClick={() => {
              setAlertSeconds(lengthDraft);
              close();
            }}>
            <CheckIcon weight="bold" aria-hidden="true" />
            Save
          </Button>
        </div>
      </BottomSheet>

      <AppearanceModal visible={sheet === 'appearance'} onClose={close} />
      <InfoModal visible={sheet === 'help'} onClose={close} />
      <ConfirmModal
        visible={sheet === 'signOut'}
        title="Sign out?"
        message="You will need your email and password to sign back in."
        confirmLabel="Sign out"
        destructive
        onConfirm={() => {
          setSheet(null);
          void signOut();
        }}
        onClose={close}
      />
    </>
  );
}
