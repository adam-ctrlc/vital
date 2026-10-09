import { App as CapacitorApp } from '@capacitor/app';
import { lazy, Suspense, useEffect } from 'react';
import { BrowserRouter, Navigate, Route, Routes, useLocation, useNavigate } from 'react-router';

import { AppLoading } from '@/components/app-loading';
import { ConnectivityGate } from '@/components/connectivity-gate';
import { UpdateGate } from '@/components/update-gate';
import { AuthProvider } from '@/features/auth/context';
import { ConnectivityProvider } from '@/features/connectivity/context';
import { AppearanceProvider } from '@/lib/appearance';
import { IS_NATIVE } from '@/lib/platform';
import { isUpdateRequired } from '@/lib/updates/store';
import { markBundleHealthy } from '@/lib/updates/updater';
import Index from '@/routes/index';
import TabsLayout from '@/routes/tabs/layout';

// Each screen is its own file, fetched the first time it is opened, so starting the app does
// not wait on screens nobody has visited yet.
const LoginScreen = lazy(() => import('@/routes/login'));
const DashboardScreen = lazy(() => import('@/routes/tabs/dashboard'));
const AlertsScreen = lazy(() => import('@/routes/tabs/alerts'));
const LogsScreen = lazy(() => import('@/routes/tabs/logs'));
const SettingsScreen = lazy(() => import('@/routes/tabs/settings'));
const ProfileScreen = lazy(() => import('@/routes/tabs/profile'));
const UsersScreen = lazy(() => import('@/routes/users'));

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
                <Suspense fallback={<AppLoading />}>
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
                </Suspense>
              </ConnectivityGate>
            </UpdateGate>
          </AppearanceProvider>
        </AuthProvider>
      </ConnectivityProvider>
    </BrowserRouter>
  );
}
