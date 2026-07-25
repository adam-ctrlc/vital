import '@/global.css';

import { ThemeProvider } from '@react-navigation/native';
import { PortalHost } from '@rn-primitives/portal';
import { Stack } from 'expo-router';
import { StatusBar } from 'expo-status-bar';
import { useColorScheme } from 'nativewind';

import { ConnectivityGate } from '@/components/connectivity-gate';
import { AuthProvider } from '@/features/auth/context';
import { ConnectivityProvider } from '@/features/connectivity/context';
import { AppearanceProvider } from '@/lib/appearance';
import { NAV_THEME } from '@/lib/theme';

export default function RootLayout() {
  const { colorScheme } = useColorScheme();
  const scheme = colorScheme === 'dark' ? 'dark' : 'light';

  return (
    <ThemeProvider value={NAV_THEME[scheme]}>
      <StatusBar style={scheme === 'dark' ? 'light' : 'dark'} />
      {/* The gate sits inside AuthProvider rather than above it, so a connection that
          drops and returns does not tear down the session and re-read the keychain. */}
      <ConnectivityProvider>
        <AuthProvider>
          <AppearanceProvider>
            <ConnectivityGate>
              <Stack screenOptions={{ headerShown: false }} />
            </ConnectivityGate>
            <PortalHost />
          </AppearanceProvider>
        </AuthProvider>
      </ConnectivityProvider>
    </ThemeProvider>
  );
}
