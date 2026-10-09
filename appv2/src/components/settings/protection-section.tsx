import {
  ArrowsClockwiseIcon,
  CheckIcon,
  LightningIcon,
  PlugsIcon,
  ThermometerIcon,
  TimerIcon,
  XIcon,
} from '@phosphor-icons/react';
import { useEffect, useState } from 'react';

import { BottomSheet } from '@/components/bottom-sheet';
import { Button } from '@/components/ui/button';
import { IconInput } from '@/components/ui/icon-input';
import { SettingsRow, SettingsSection } from '@/components/ui/settings-list';
import { Slider } from '@/components/ui/slider';
import { useAuth } from '@/features/auth/context';
import * as settingsApi from '@/features/settings/api';
import {
  DEFAULT_SECONDS,
  MAX_SECONDS,
  MIN_SECONDS,
  STEP_SECONDS,
  formatDelay,
} from '@/features/settings/reclose-delay';
import {
  TRIP_DEFAULT_SECONDS,
  TRIP_MAX_SECONDS,
  TRIP_MIN_SECONDS,
  TRIP_STEP_SECONDS,
} from '@/features/settings/trip-delay';
import type { Settings } from '@/features/settings/types';
import { useAppearance } from '@/lib/appearance';

/** The degree sign is part of the unit symbol, so it is written out rather than dropped. */
const DEGREE_C = '°C';

/** How long "Saved" stays under the section after a change lands. */
const SAVED_MS = 3000;

type DelayKind = 'trip' | 'reclose';

const DELAYS: Record<
  DelayKind,
  { title: string; hint: string; min: number; max: number; step: number }
> = {
  trip: {
    title: 'Trip delay',
    hint: 'How long an overload must last before the relay opens.',
    min: TRIP_MIN_SECONDS,
    max: TRIP_MAX_SECONDS,
    step: TRIP_STEP_SECONDS,
  },
  reclose: {
    title: 'Reclose delay',
    hint: 'How long the load stays off before the board closes the relay again.',
    min: MIN_SECONDS,
    max: MAX_SECONDS,
    step: STEP_SECONDS,
  },
};

/**
 * Everything that decides when the transformer is protected: the three thresholds and the
 * two relay timings, as rows showing their values. Editing happens in a sheet, so the
 * screen reads as a summary instead of a wall of greyed-out inputs.
 *
 * The settings endpoint takes every field together, so each save sends the current values
 * back alongside the one that changed.
 */
export function ProtectionSection({
  settings,
  loading,
  onSaved,
}: {
  settings: Settings | null;
  loading: boolean;
  onSaved: (next: Settings) => void;
}) {
  const { primary } = useAppearance();
  const [editingThresholds, setEditingThresholds] = useState(false);
  const [editingDelay, setEditingDelay] = useState<DelayKind | null>(null);
  const [savedAt, setSavedAt] = useState<number | null>(null);

  useEffect(() => {
    if (savedAt === null) return;
    const timer = setTimeout(() => setSavedAt(null), SAVED_MS);
    return () => clearTimeout(timer);
  }, [savedAt]);

  function handleSaved(next: Settings) {
    onSaved(next);
    setSavedAt(Date.now());
  }

  const trip = settings?.tripConfirmSeconds ?? TRIP_DEFAULT_SECONDS;
  const reclose = settings?.recloseDelaySeconds ?? DEFAULT_SECONDS;
  const ready = settings !== null;

  return (
    <>
      <SettingsSection
        title="Protection"
        footer={savedAt !== null ? 'Saved' : null}
        footerTone="primary">
        <SettingsRow
          icon={LightningIcon}
          iconColor={primary.hex}
          label="Alarm threshold"
          value={settings ? `${settings.loadThresholdVa} VA` : undefined}
          loading={loading}
          disabled={!ready}
          onClick={() => setEditingThresholds(true)}
        />
        <SettingsRow
          icon={PlugsIcon}
          iconColor={primary.hex}
          label="Trip threshold"
          value={settings ? `${settings.tripThresholdVa} VA` : undefined}
          loading={loading}
          disabled={!ready}
          onClick={() => setEditingThresholds(true)}
        />
        <SettingsRow
          icon={ThermometerIcon}
          iconColor={primary.hex}
          label="Temperature limit"
          value={settings ? `${settings.tempThresholdC} ${DEGREE_C}` : undefined}
          loading={loading}
          disabled={!ready}
          onClick={() => setEditingThresholds(true)}
        />
        <SettingsRow
          icon={TimerIcon}
          iconColor={primary.hex}
          label="Trip delay"
          value={formatDelay(trip)}
          loading={loading}
          disabled={!ready}
          onClick={() => setEditingDelay('trip')}
        />
        <SettingsRow
          icon={ArrowsClockwiseIcon}
          iconColor={primary.hex}
          label="Reclose delay"
          value={formatDelay(reclose)}
          loading={loading}
          disabled={!ready}
          onClick={() => setEditingDelay('reclose')}
        />
      </SettingsSection>

      {settings ? (
        <>
          <ThresholdsSheet
            visible={editingThresholds}
            settings={settings}
            onClose={() => setEditingThresholds(false)}
            onSaved={handleSaved}
          />
          {editingDelay ? (
            <DelaySheet
              kind={editingDelay}
              settings={settings}
              onClose={() => setEditingDelay(null)}
              onSaved={handleSaved}
            />
          ) : null}
        </>
      ) : null}
    </>
  );
}

function Field({ label, hint, children }: { label: string; hint?: string; children: React.ReactNode }) {
  return (
    <label className="block space-y-1.5">
      <span className="flex items-baseline justify-between">
        <span className="text-sm font-medium">{label}</span>
        {hint ? <span className="text-muted-foreground text-[11px]">{hint}</span> : null}
      </span>
      {children}
    </label>
  );
}

function SheetActions({
  busy,
  canSave,
  onCancel,
  onSave,
}: {
  busy: boolean;
  canSave: boolean;
  onCancel: () => void;
  /** Omitted inside a form, where the Save button submits it instead. */
  onSave?: () => void;
}) {
  return (
    <div className="flex gap-2">
      <Button variant="outline" className="flex-1" disabled={busy} onClick={onCancel}>
        <XIcon weight="bold" aria-hidden="true" />
        Cancel
      </Button>
      <Button type="submit" className="flex-1" disabled={busy || !canSave} onClick={onSave}>
        <CheckIcon weight="bold" aria-hidden="true" />
        {busy ? 'Saving...' : 'Save'}
      </Button>
    </div>
  );
}

function ThresholdsSheet({
  visible,
  settings,
  onClose,
  onSaved,
}: {
  visible: boolean;
  settings: Settings;
  onClose: () => void;
  onSaved: (next: Settings) => void;
}) {
  const { token } = useAuth();
  const { primary } = useAppearance();

  const initial = {
    load: String(settings.loadThresholdVa),
    trip: String(settings.tripThresholdVa),
    temp: String(settings.tempThresholdC),
  };
  const [draft, setDraft] = useState(initial);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  // Starts from what is saved every time it opens, so a cancelled edit does not linger.
  useEffect(() => {
    if (!visible) return;
    setDraft({
      load: String(settings.loadThresholdVa),
      trip: String(settings.tripThresholdVa),
      temp: String(settings.tempThresholdC),
    });
    setError(null);
  }, [visible, settings]);

  const dirty =
    draft.load !== initial.load || draft.trip !== initial.trip || draft.temp !== initial.temp;

  async function save() {
    const load = Number(draft.load);
    const trip = Number(draft.trip);
    const temp = Number(draft.temp);
    if (![load, trip, temp].every((value) => Number.isFinite(value) && value > 0)) {
      setError('Enter a positive number for every threshold.');
      return;
    }
    // Checked here as well as by the API so the mistake is caught before a round trip.
    // Equal values would cut the load in the same instant the alert appears.
    if (trip <= load) {
      setError('The trip threshold must be higher than the alarm.');
      return;
    }

    setBusy(true);
    setError(null);
    try {
      const result = await settingsApi.update(
        token ?? '',
        load,
        trip,
        temp,
        settings.recloseDelaySeconds,
        settings.tripConfirmSeconds
      );
      onSaved(result);
      onClose();
    } catch (caught) {
      setError((caught as Error).message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <BottomSheet visible={visible} title="Thresholds" onClose={onClose}>
      <form
        className="flex flex-col gap-4"
        onSubmit={(event) => {
          event.preventDefault();
          if (dirty && !busy) void save();
        }}>
        <Field label="Alarm threshold" hint="Default 900 VA">
          <IconInput
            icon={LightningIcon}
            iconColor={primary.hex}
            unit="VA"
            value={draft.load}
            onChange={(event) => setDraft((prev) => ({ ...prev, load: event.target.value }))}
            inputMode="decimal"
            placeholder="900"
          />
        </Field>

        <Field label="Trip threshold" hint="Default 980 VA">
          <IconInput
            icon={PlugsIcon}
            iconColor={primary.hex}
            unit="VA"
            value={draft.trip}
            onChange={(event) => setDraft((prev) => ({ ...prev, trip: event.target.value }))}
            inputMode="decimal"
            placeholder="980"
          />
        </Field>

        <Field label="Temperature limit" hint={`Default 40 ${DEGREE_C}`}>
          <IconInput
            icon={ThermometerIcon}
            iconColor={primary.hex}
            unit={DEGREE_C}
            value={draft.temp}
            onChange={(event) => setDraft((prev) => ({ ...prev, temp: event.target.value }))}
            inputMode="decimal"
            placeholder="40"
          />
        </Field>

        <p className="text-muted-foreground text-xs">
          The alarm raises an alert. The trip cuts the load, so keep it above the alarm.
        </p>

        {error ? <p className="text-destructive text-sm">{error}</p> : null}

        {/* Submits the form, so Enter in any field saves too. */}
        <SheetActions busy={busy} canSave={dirty} onCancel={onClose} />
      </form>
    </BottomSheet>
  );
}

function DelaySheet({
  kind,
  settings,
  onClose,
  onSaved,
}: {
  kind: DelayKind;
  settings: Settings;
  onClose: () => void;
  onSaved: (next: Settings) => void;
}) {
  const { token } = useAuth();
  const { primary } = useAppearance();

  const spec = DELAYS[kind];
  const saved = kind === 'trip' ? settings.tripConfirmSeconds : settings.recloseDelaySeconds;
  const [draft, setDraft] = useState(saved);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function save() {
    setBusy(true);
    setError(null);
    try {
      const result = await settingsApi.update(
        token ?? '',
        settings.loadThresholdVa,
        settings.tripThresholdVa,
        settings.tempThresholdC,
        kind === 'reclose' ? draft : settings.recloseDelaySeconds,
        kind === 'trip' ? draft : settings.tripConfirmSeconds
      );
      onSaved(result);
      onClose();
    } catch (caught) {
      setError((caught as Error).message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <BottomSheet visible title={spec.title} onClose={onClose}>
      <div className="space-y-1 pt-2 text-center">
        <p className="text-3xl font-bold tabular-nums" style={{ color: primary.hex }}>
          {formatDelay(draft)}
        </p>
        <p className="text-muted-foreground text-xs">{spec.hint}</p>
      </div>

      <Slider
        min={spec.min}
        max={spec.max}
        step={spec.step}
        value={draft}
        color={primary.hex}
        aria-label={spec.title}
        formatEnd={formatDelay}
        onValueChange={setDraft}
      />

      {error ? <p className="text-destructive text-sm">{error}</p> : null}

      <SheetActions
        busy={busy}
        canSave={draft !== saved}
        onCancel={onClose}
        onSave={() => void save()}
      />
    </BottomSheet>
  );
}
