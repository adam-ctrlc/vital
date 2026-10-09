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

// Each screen is its own file. All of them start downloading here, while the loading screen
// is still up, so by the time the session is checked the first screen is ready and no
// second loader follows the first. Each import runs once; lazy() reuses its promise.
function preload<T>(load: () => Promise<T>): () => Promise<T> {
  const loading = load();
  return () => loading;
}

const LoginScreen = lazy(preload(() => import('@/routes/login')));
const DashboardScreen = lazy(preload(() => import('@/routes/tabs/dashboard')));
const AlertsScreen = lazy(preload(() => import('@/routes/tabs/alerts')));
const LogsScreen = lazy(preload(() => import('@/routes/tabs/logs')));
const SettingsScreen = lazy(preload(() => import('@/routes/tabs/settings')));
const ProfileScreen = lazy(preload(() => import('@/routes/tabs/profile')));
const UsersScreen = lazy(preload(() => import('@/routes/users')));
const EnergyScreen = lazy(preload(() => import('@/routes/analysis/energy')));
const PeakHoursScreen = lazy(preload(() => import('@/routes/analysis/peak-hours')));
const PowerQualityScreen = lazy(preload(() => import('@/routes/analysis/power-quality')));
const AgingScreen = lazy(preload(() => import('@/routes/analysis/aging')));
const ReportsScreen = lazy(preload(() => import('@/routes/analysis/reports')));
const AuditScreen = lazy(preload(() => import('@/routes/analysis/audit')));

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
                      <Route path="energy" element={<EnergyScreen />} />
                      <Route path="peak-hours" element={<PeakHoursScreen />} />
                      <Route path="power-quality" element={<PowerQualityScreen />} />
                      <Route path="aging" element={<AgingScreen />} />
                      <Route path="reports" element={<ReportsScreen />} />
                      <Route path="audit" element={<AuditScreen />} />
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
