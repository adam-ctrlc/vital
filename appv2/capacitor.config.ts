import type { CapacitorConfig } from '@capacitor/cli';

const config: CapacitorConfig = {
  appId: 'com.peregrineadrift.vital',
  appName: 'Vital',
  webDir: 'dist',
  plugins: {
    // Not patched over fetch: the API already sends CORS headers, and the patched fetch
    // ignores AbortSignal, which every poll relies on. features/readings/lan.ts calls
    // the plugin directly for the one request that needs it.
    CapacitorHttp: { enabled: false },
    // Live updates come only from Vital's own GitHub releases (src/lib/updates): no checks
    // against Capgo's cloud and no usage statistics sent anywhere. The app decides when to
    // update, and a version that does not report itself ready in time is rolled back.
    CapacitorUpdater: {
      autoUpdate: false,
      statsUrl: '',
      appReadyTimeout: 15000,
    },
    LocalNotifications: { iconColor: '#208AEF' },
    PushNotifications: { presentationOptions: ['badge', 'sound', 'alert'] },
  },
};

export default config;
