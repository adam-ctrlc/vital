import { App as CapacitorApp } from '@capacitor/app';
import { useEffect } from 'react';
import { BrowserRouter, Navigate, Route, Routes, useLocation, useNavigate } from 'react-router';

import { ConnectivityGate } from '@/components/connectivity-gate';
import { UpdateGate } from '@/components/update-gate';
import { AuthProvider } from '@/features/auth/context';
import { ConnectivityProvider } from '@/features/connectivity/context';
import { AppearanceProvider } from '@/lib/appearance';
import { IS_NATIVE } from '@/lib/platform';
import { isUpdateRequired } from '@/lib/updates/store';
import { markBundleHealthy } from '@/lib/updates/updater';
import Index from '@/routes/index';
import LoginScreen from '@/routes/login';
import AlertsScreen from '@/routes/tabs/alerts';
import DashboardScreen from '@/routes/tabs/dashboard';
import TabsLayout from '@/routes/tabs/layout';
import LogsScreen from '@/routes/tabs/logs';
import ProfileScreen from '@/routes/tabs/profile';
import SettingsScreen from '@/routes/tabs/settings';
import UsersScreen from '@/routes/users';

/** Android's back gesture walks the history, and leaves the app from the first page. */
function BackButton() {
  const navigate = useNavigate();

  useEffect(() => {
    if (!IS_NATIVE) return;

    const listener = CapacitorApp.addListener('backButton', ({ canGoBack }) => {
      // The update screen is not something to back out of.
      if (isUpdateRequired()) return;
      if (canGoBack) navigate(-1);
      else void CapacitorApp.exitApp();
    });

    return () => {
      void listener.then((handle) => handle.remove());
    };
  }, [navigate]);

  return null;
}

/** The document scrolls now, so a new page starts at the top rather than mid-way down. */
function ScrollToTop() {
  const { pathname } = useLocation();

  useEffect(() => {
    window.scrollTo(0, 0);
  }, [pathname]);

  return null;
}

export default function App() {
  // This version rendered, so it works. Without this the updater rolls a live update back.
  useEffect(() => {
    void markBundleHealthy();
  }, []);

  return (
    <BrowserRouter>
      <BackButton />
      <ScrollToTop />
      {/* The gate sits inside AuthProvider rather than above it, so a connection that
          drops and returns does not tear down the session and re-read storage. */}
      <ConnectivityProvider>
        <AuthProvider>
          <AppearanceProvider>
            {/* Inside the appearance provider, so the update screen wears the chosen theme. */}
            <UpdateGate>
              <ConnectivityGate>
                <Routes>
                  <Route index element={<Index />} />
                  <Route path="login" element={<LoginScreen />} />
                  <Route element={<TabsLayout />}>
                    <Route path="users" element={<UsersScreen />} />
                    <Route path="dashboard" element={<DashboardScreen />} />
                    <Route path="alerts" element={<AlertsScreen />} />
                    <Route path="logs" element={<LogsScreen />} />
                    <Route path="settings" element={<SettingsScreen />} />
                    <Route path="profile" element={<ProfileScreen />} />
                  </Route>
                  <Route path="*" element={<Navigate to="/" replace />} />
                </Routes>
              </ConnectivityGate>
            </UpdateGate>
          </AppearanceProvider>
        </AuthProvider>
      </ConnectivityProvider>
    </BrowserRouter>
  );
}
