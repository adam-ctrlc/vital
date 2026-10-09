import {
  ClipboardTextIcon,
  ClockIcon,
  FileTextIcon,
  GearIcon,
  HourglassMediumIcon,
  InfoIcon,
  LightningIcon,
  UsersIcon,
  WaveSineIcon,
} from '@phosphor-icons/react';
import { useCallback, useEffect, useState } from 'react';
import { Navigate, useNavigate } from 'react-router';

import { InfoModal } from '@/components/info-modal';
import { DeviceSection, type DeviceNotice } from '@/components/settings/device-section';
import { ProtectionSection } from '@/components/settings/protection-section';
import { RelaySection } from '@/components/settings/relay-section';
import { SourceModeModal } from '@/components/source-mode-modal';
import { PageHeader } from '@/components/ui/page-header';
import { SettingsRow, SettingsSection } from '@/components/ui/settings-list';
import { useAuth } from '@/features/auth/context';
import * as deviceApi from '@/features/device/api';
import * as settingsApi from '@/features/settings/api';
import type { Settings, SourceMode } from '@/features/settings/types';
import { usePoll } from '@/hooks/use-poll';
import { useAppearance } from '@/lib/appearance';

/** How often the board's link state refreshes. */
const DEVICE_POLL_MS = 5000;

/** How long the "connected" confirmation stays up. */
const SUCCESS_MS = 4000;

export default function SettingsScreen() {
  const { token, user } = useAuth();
  const navigate = useNavigate();
  const { primary } = useAppearance();

  const [settings, setSettings] = useState<Settings | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  // Matches the server's default, so the switch does not show Simulation for the moment
  // before the real setting loads and then flick over to ESP32.
  const [sourceMode, setSourceMode] = useState<SourceMode>('hardware');
  const [sourceNotice, setSourceNotice] = useState<DeviceNotice | null>(null);
  const [connecting, setConnecting] = useState(false);
  const [showHelp, setShowHelp] = useState(false);

  const refresh = useCallback(async () => {
    setLoading(true);
    try {
      const current = await settingsApi.read(token ?? '');
      setSettings(current);
      setSourceMode(current.sourceMode);
      setLoadError(null);
    } catch (caught) {
      setLoadError((caught as Error).message);
    } finally {
      setLoading(false);
    }
  }, [token]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  // A confirmation is a moment, not a state, so it clears itself. Errors stay until the
  // next attempt.
  useEffect(() => {
    if (sourceNotice?.tone !== 'success') return;
    const timer = setTimeout(() => setSourceNotice(null), SUCCESS_MS);
    return () => clearTimeout(timer);
  }, [sourceNotice]);

  // Polled whatever the chosen source, so the board shows as available even while
  // readings still come from the simulation.
  const deviceFetcher = useCallback(
    (signal: AbortSignal) => deviceApi.status(token ?? '', signal),
    [token]
  );
  const { data: device } = usePoll(deviceFetcher, DEVICE_POLL_MS, Boolean(token));

  async function changeSource(next: SourceMode) {
    if (next === sourceMode) return;

    const previous = sourceMode;
    setSourceMode(next);
    setSourceNotice(null);
    try {
      await settingsApi.setSourceMode(token ?? '', next);
      // Switching to the board waits for it to report, in a sheet that says so.
      if (next === 'hardware') setConnecting(true);
    } catch (caught) {
      setSourceMode(previous);
      setSourceNotice({
        tone: 'destructive',
        title: 'Could not switch the data source',
        description: (caught as Error).message,
      });
    }
  }

  // Stable, because the waiting sheet restarts its success timer whenever these change,
  // and the device poll re-renders this page every few seconds.
  const handleSynced = useCallback(() => {
    setConnecting(false);
    setSourceNotice({ tone: 'success', title: 'ESP32 connected', description: 'Live readings are on.' });
  }, []);

  // Closing the wait keeps ESP32 mode. The Device section shows it is still waiting, for
  // as long as the board stays quiet.
  const handleWaitDismissed = useCallback(() => {
    setConnecting(false);
    setSourceNotice(null);
  }, []);

  // Hiding the tab only removes the link; typing `/settings` still lands here. The API
  // enforces this too; the redirect just avoids a wall of 403s.
  if (!token) return <Navigate to="/login" replace />;
  if (user && user.role !== 'admin') return <Navigate to="/dashboard" replace />;

  return (
    <>
      <PageHeader icon={GearIcon} iconColor={primary.hex} title="Settings" />

      {loadError ? <p className="text-destructive text-sm">{loadError}</p> : null}

      <RelaySection />

      <ProtectionSection settings={settings} loading={loading} onSaved={setSettings} />

      <DeviceSection
        status={device}
        sourceMode={sourceMode}
        sourceLoading={loading}
        onSourceChange={(next) => void changeSource(next)}
        notice={sourceNotice}
      />

      {/* Wide screens reach these from the sidebar. */}
      <div className="md:hidden">
        <SettingsSection title="Analysis">
          <SettingsRow icon={LightningIcon} iconColor={primary.hex} label="Energy & cost" onClick={() => navigate('/energy')} />
          <SettingsRow icon={ClockIcon} iconColor={primary.hex} label="Peak hours" onClick={() => navigate('/peak-hours')} />
          <SettingsRow icon={WaveSineIcon} iconColor={primary.hex} label="Power quality" onClick={() => navigate('/power-quality')} />
          <SettingsRow icon={HourglassMediumIcon} iconColor={primary.hex} label="Transformer aging" onClick={() => navigate('/aging')} />
          <SettingsRow icon={FileTextIcon} iconColor={primary.hex} label="Reports" onClick={() => navigate('/reports')} />
        </SettingsSection>
      </div>

      <SettingsSection title="Administration">
        <SettingsRow
          icon={UsersIcon}
          iconColor={primary.hex}
          label="User accounts"
          onClick={() => navigate('/users')}
        />
        <SettingsRow icon={ClipboardTextIcon} iconColor={primary.hex} label="Audit log" onClick={() => navigate('/audit')} />
      </SettingsSection>

      <SettingsSection title="Help">
        <SettingsRow
          icon={InfoIcon}
          iconColor={primary.hex}
          label="How it works"
          onClick={() => setShowHelp(true)}
        />
      </SettingsSection>

      <InfoModal visible={showHelp} onClose={() => setShowHelp(false)} />

      <SourceModeModal
        visible={connecting}
        token={token}
        onSynced={handleSynced}
        onCancel={handleWaitDismissed}
      />
    </>
  );
}
