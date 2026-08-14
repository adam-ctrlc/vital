import { useColorScheme } from 'nativewind';
import WarningCircle from 'phosphor-react-native/src/icons/WarningCircle';
import WifiHigh from 'phosphor-react-native/src/icons/WifiHigh';
import WifiSlash from 'phosphor-react-native/src/icons/WifiSlash';
import { useCallback, useEffect, useState } from 'react';
import { View } from 'react-native';

import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Skeleton } from '@/components/ui/skeleton';
import { Text } from '@/components/ui/text';
import { useAuth } from '@/features/auth/context';
import * as deviceApi from '@/features/device/api';
import type { DeviceStatus } from '@/features/device/types';
import { useAppearance } from '@/lib/appearance';

const STATUS_POLL_MS = 5000;

function uptimeLabel(seconds: number | null): string {
  if (seconds === null) return '--';
  const hours = Math.floor(seconds / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);

  return hours > 0 ? `${hours}h ${minutes}m` : `${minutes}m`;
}

function Detail({ label, value }: { label: string; value: string }) {
  return (
    <View className="gap-0.5">
      <Text variant="muted" className="text-[10px] uppercase">
        {label}
      </Text>
      <Text className="text-xs font-medium">{value}</Text>
    </View>
  );
}

export function DeviceCard() {
  const { token } = useAuth();
  const { primary } = useAppearance();
  const { colorScheme } = useColorScheme();
  const isDark = colorScheme === 'dark';
  const muted = isDark ? '#a1a1aa' : '#71717a';
  const danger = isDark ? '#f87171' : '#dc2626';

  const [status, setStatus] = useState<DeviceStatus | null>(null);
  const [loading, setLoading] = useState(true);
  const load = useCallback(async () => {
    setLoading(true);
    try {
      const live = await deviceApi.status(token ?? '');
      setStatus(live);
    } catch {
      // ignore load failures; status polling retries
    } finally {
      setLoading(false);
    }
  }, [token]);

  useEffect(() => {
    void load();
  }, [load]);

  useEffect(() => {
    if (!token) return;

    const controller = new AbortController();
    const id = setInterval(() => {
      deviceApi
        .status(token, controller.signal)
        .then(setStatus)
        .catch(() => undefined);
    }, STATUS_POLL_MS);

    return () => {
      controller.abort();
      clearInterval(id);
    };
  }, [token]);

  const connected = status?.connected ?? false;
  const accent = connected ? primary.hex : danger;
  const hasReported = status?.deviceId != null;

  return (
    <View className="gap-4">
      <Card className="gap-0 py-0">
        <CardHeader className="border-border flex-row items-center justify-between border-b p-4">
          <View className="flex-1 gap-0.5">
            <CardTitle className="text-base">ESP32 device</CardTitle>
            <Text variant="muted" className="text-xs">
              The sensor board that reports readings.
            </Text>
          </View>
          {loading ? (
            <Skeleton className="h-5 w-20 rounded-full" />
          ) : (
            <Badge variant={connected ? 'default' : 'destructive'}>
              <Text>{connected ? 'CONNECTED' : 'OFFLINE'}</Text>
            </Badge>
          )}
        </CardHeader>

        <CardContent className="gap-3 p-4">
          {loading ? (
            <>
              <Skeleton className="h-10 w-full" />
              <Skeleton className="h-10 w-full" />
            </>
          ) : (
            <>
              <View className="flex-row items-center gap-3">
                <View
                  className="h-10 w-10 items-center justify-center rounded-full"
                  style={{ backgroundColor: `${accent}1f` }}>
                  {connected ? (
                    <WifiHigh size={20} weight="bold" color={accent} />
                  ) : (
                    <WifiSlash size={20} weight="bold" color={accent} />
                  )}
                </View>
                <View className="flex-1 gap-0.5">
                  <Text className="text-sm font-semibold">{status?.ssid ?? '--'}</Text>
                  <Text variant="muted" className="text-xs">
                    {connected
                      ? `Last seen ${status?.lastSeenLabel ?? '--'}`
                      : 'No report received'}
                  </Text>
                </View>
              </View>

              <View className="flex-row flex-wrap gap-x-6 gap-y-2">
                <Detail label="Device" value={status?.deviceId ?? '--'} />
                <Detail label="IP" value={status?.ipAddress ?? '--'} />
                <Detail
                  label="Signal"
                  value={status?.signalDbm == null ? '--' : `${status.signalDbm} dBm`}
                />
                <Detail label="Uptime" value={uptimeLabel(status?.uptimeSeconds ?? null)} />
                <Detail label="Firmware" value={status?.firmware ?? '--'} />
              </View>

              {hasReported ? null : (
                <View className="flex-row items-center gap-1.5">
                  <WarningCircle size={13} weight="bold" color={muted} />
                  <Text variant="muted" className="flex-1 text-[10px]">
                    The board has not reported yet.
                  </Text>
                </View>
              )}
            </>
          )}
        </CardContent>
      </Card>
    </View>
  );
}
