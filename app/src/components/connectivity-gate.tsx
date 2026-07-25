import { useColorScheme } from 'nativewind';
import ArrowsClockwise from 'phosphor-react-native/src/icons/ArrowsClockwise';
import CloudSlash from 'phosphor-react-native/src/icons/CloudSlash';
import WifiSlash from 'phosphor-react-native/src/icons/WifiSlash';
import { type ReactNode } from 'react';
import { ActivityIndicator, View } from 'react-native';

import { Button } from '@/components/ui/button';
import { Text } from '@/components/ui/text';
import { useConnectivity } from '@/features/connectivity/context';

const COPY = {
  offline: {
    icon: WifiSlash,
    title: 'No internet connection',
    description:
      'VITAL reads the transformer live and keeps nothing on the phone, so it cannot show anything until you are back online. Turn on Wi-Fi or mobile data and this will clear on its own.',
  },
  unreachable: {
    icon: CloudSlash,
    title: 'Cannot reach VITAL',
    description:
      'Your device is connected, but the server is not answering. A Wi-Fi network that still wants you to sign in will do this, and so will the API being down. Retrying every few seconds.',
  },
} as const;

/** Matches `--primary-foreground`, which the appearance provider pins to white. */
const ON_PRIMARY = '#ffffff';

/**
 * Holds the app closed until there is a connection that can actually carry data.
 *
 * Deliberately not dismissible. Every screen in VITAL is a live read of the API and
 * nothing is cached, so letting someone in without a connection puts them on a
 * dashboard of empty dashes with no explanation of why. For a monitoring app that is
 * worse than a clear stop: blank readings look like a calm transformer.
 *
 * Two failures are distinguished, because "check your connection" is unhelpful advice
 * to someone whose connection is fine. See `Connectivity` in the context.
 */
export function ConnectivityGate({ children }: { children: ReactNode }) {
  const { status, checking, recheck } = useConnectivity();
  const { colorScheme } = useColorScheme();

  if (status === 'online') return <>{children}</>;

  // First launch, before any verdict. A spinner rather than a failure, so a slow cold
  // start does not accuse the user's network of being broken.
  if (status === 'checking') {
    return (
      <View className="bg-background flex-1 items-center justify-center">
        <ActivityIndicator />
      </View>
    );
  }

  const { icon: Icon, title, description } = COPY[status];
  const iconColor = colorScheme === 'dark' ? '#52525b' : '#d4d4d8';

  return (
    <View className="bg-background flex-1 items-center justify-center p-8">
      <View className="w-full max-w-sm items-center gap-6">
        <Icon size={88} weight="duotone" color={iconColor} />

        <View className="items-center gap-2">
          <Text className="text-xl font-semibold">{title}</Text>
          <Text variant="muted" className="text-center text-sm leading-5">
            {description}
          </Text>
        </View>

        <Button className="w-full flex-row items-center gap-2" disabled={checking} onPress={recheck}>
          {checking ? (
            <ActivityIndicator size="small" />
          ) : (
            <ArrowsClockwise size={16} weight="bold" color={ON_PRIMARY} />
          )}
          <Text>{checking ? 'Checking...' : 'Try again'}</Text>
        </Button>
      </View>
    </View>
  );
}
