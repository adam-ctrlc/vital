import { WarningCircleIcon, WifiHighIcon, WifiSlashIcon } from '@phosphor-icons/react';

import { Badge } from '@/components/ui/badge';
import { Callout, type CalloutTone } from '@/components/ui/callout';
import { Segmented } from '@/components/ui/segmented';
import { SettingsSection } from '@/components/ui/settings-list';
import { Skeleton } from '@/components/ui/skeleton';
import type { DeviceStatus } from '@/features/device/types';
import type { SourceMode } from '@/features/settings/types';
import { useAppearance, useColorScheme } from '@/lib/appearance';

const SOURCE_OPTIONS: { label: string; value: SourceMode }[] = [
  { label: 'Simulation', value: 'simulation' },
  { label: 'ESP32', value: 'hardware' },
];

export type DeviceNotice = { tone: CalloutTone; title: string; description?: string };

function uptimeLabel(seconds: number | null): string {
  if (seconds === null) return '--';
  const hours = Math.floor(seconds / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);

  return hours > 0 ? `${hours}h ${minutes}m` : `${minutes}m`;
}

/**
 * Where readings come from, and the board that sends them. One section, because the
 * source switch and the board's link state answer the same question: is this live?
 */
export function DeviceSection({
  status,
  sourceMode,
  sourceLoading,
  onSourceChange,
  notice,
}: {
  status: DeviceStatus | null;
  sourceMode: SourceMode;
  sourceLoading: boolean;
  onSourceChange: (next: SourceMode) => void;
  /** Something that just happened, such as a switch failing. Shown above the derived state. */
  notice?: DeviceNotice | null;
}) {
  const { primary } = useAppearance();
  const { colorScheme } = useColorScheme();
  const danger = colorScheme === 'dark' ? '#f87171' : '#dc2626';

  const loading = status === null;
  const connected = status?.connected ?? false;
  const accent = connected ? primary.hex : danger;
  // Derived rather than set by whoever switched the source, so it also covers a board that
  // drops off later, and clears itself the moment the board reports again.
  const waiting = sourceMode === 'hardware' && status !== null && !connected;

  const details = [
    { label: 'Device', value: status?.deviceId ?? '--' },
    { label: 'IP', value: status?.ipAddress ?? '--' },
    { label: 'Signal', value: status?.signalDbm == null ? '--' : `${status.signalDbm} dBm` },
    { label: 'Uptime', value: uptimeLabel(status?.uptimeSeconds ?? null) },
    { label: 'Firmware', value: status?.firmware ?? '--' },
  ];

  return (
    <SettingsSection title="Device">
      <div className="flex items-center justify-between gap-3 px-4 py-3">
        <span className="text-sm font-medium">Data source</span>
        {sourceLoading ? (
          <Skeleton className="h-8 w-40 rounded-full" />
        ) : (
          <Segmented
            aria-label="Data source"
            options={SOURCE_OPTIONS}
            value={sourceMode}
            onValueChange={onSourceChange}
            size="sm"
          />
        )}
      </div>

      {notice || waiting ? (
        <div className="p-3">
          {notice ? (
            <Callout tone={notice.tone} title={notice.title} description={notice.description} />
          ) : (
            <Callout
              tone="warning"
              live
              title="Waiting for the ESP32"
              description="Readings appear on the Monitor as soon as the board reports."
            />
          )}
        </div>
      ) : null}

      <div className="space-y-3 p-4">
        <div className="flex items-center gap-3">
          <span
            className="grid size-10 shrink-0 place-items-center rounded-full"
            style={{ backgroundColor: `${accent}1f` }}>
            {connected ? (
              <WifiHighIcon size={20} weight="bold" color={accent} aria-hidden="true" />
            ) : (
              <WifiSlashIcon size={20} weight="bold" color={accent} aria-hidden="true" />
            )}
          </span>
          <div className="min-w-0 flex-1">
            <p className="truncate text-sm font-semibold">ESP32 {status?.ssid ? `on ${status.ssid}` : ''}</p>
            <p className="text-muted-foreground text-xs">
              {loading
                ? 'Checking...'
                : connected
                  ? `Last seen ${status?.lastSeenLabel ?? '--'}`
                  : 'Not reporting'}
            </p>
          </div>
          {loading ? (
            <Skeleton className="h-5 w-20 rounded-full" />
          ) : (
            <Badge variant={connected ? 'default' : 'destructive'}>{connected ? 'ONLINE' : 'OFFLINE'}</Badge>
          )}
        </div>

        <dl className="grid grid-cols-3 gap-x-4 gap-y-2 sm:grid-cols-5">
          {details.map((detail) => (
            <div key={detail.label} className="min-w-0">
              <dt className="text-muted-foreground text-[10px] uppercase tracking-wide">{detail.label}</dt>
              <dd className="truncate text-xs font-medium tabular-nums">{detail.value}</dd>
            </div>
          ))}
        </dl>

        {!loading && status?.deviceId == null ? (
          <p className="text-muted-foreground flex items-center gap-1.5 text-[11px]">
            <WarningCircleIcon size={13} weight="bold" aria-hidden="true" />
            The board has not reported yet.
          </p>
        ) : null}
      </div>
    </SettingsSection>
  );
}
