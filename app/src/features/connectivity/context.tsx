import * as Network from 'expo-network';
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from 'react';

import { probeApi } from '@/features/connectivity/probe';

/**
 * `offline` is the device having no link at all, `unreachable` is having one that
 * cannot get to the API. They are kept apart because the fix differs: the first is the
 * user's Wi-Fi or data, the second is a captive portal or a server that is down, and
 * telling someone to check their connection when their connection is fine is useless.
 */
export type Connectivity = 'checking' | 'online' | 'offline' | 'unreachable';

type ConnectivityValue = {
  status: Connectivity;
  /** True while a re-check is in flight, so the retry button can show progress. */
  checking: boolean;
  recheck: () => void;
};

const ConnectivityContext = createContext<ConnectivityValue | null>(null);

export function useConnectivity() {
  const value = useContext(ConnectivityContext);
  if (!value) {
    throw new Error('useConnectivity must be used within a ConnectivityProvider');
  }
  return value;
}

/** Retry cadence while the gate is up, so recovery needs no tap. */
const RETRY_INTERVAL_MS = 5000;

export function ConnectivityProvider({ children }: { children: ReactNode }) {
  const [status, setStatus] = useState<Connectivity>('checking');
  const [checking, setChecking] = useState(true);

  // Guards against two checks racing: a manual retry landing after an automatic one
  // would otherwise be able to overwrite a newer result with a staler verdict.
  const sequence = useRef(0);
  const mounted = useRef(true);

  const check = useCallback(async () => {
    const ticket = ++sequence.current;
    setChecking(true);

    try {
      const state = await Network.getNetworkStateAsync();

      // `isInternetReachable` is undefined on some platforms and while the OS is still
      // deciding, so it only counts against the link when it is explicitly false.
      const linked = Boolean(state.isConnected) && state.isInternetReachable !== false;

      if (!linked) {
        if (mounted.current && ticket === sequence.current) setStatus('offline');
        return;
      }

      const reachable = await probeApi();
      if (mounted.current && ticket === sequence.current) {
        setStatus(reachable ? 'online' : 'unreachable');
      }
    } catch {
      // getNetworkStateAsync itself failing is not a reason to lock someone out over a
      // permissions quirk, so fall back to whether the API answers.
      const reachable = await probeApi();
      if (mounted.current && ticket === sequence.current) {
        setStatus(reachable ? 'online' : 'unreachable');
      }
    } finally {
      if (mounted.current && ticket === sequence.current) setChecking(false);
    }
  }, []);

  useEffect(() => {
    mounted.current = true;
    void check();

    return () => {
      mounted.current = false;
    };
  }, [check]);

  // Event driven rather than polled: the OS tells us the moment the link changes, so a
  // drop blocks the app immediately and a reconnect re-probes without waiting out an
  // interval. No cost while the connection is healthy.
  useEffect(() => {
    const subscription = Network.addNetworkStateListener((state) => {
      const linked = Boolean(state.isConnected) && state.isInternetReachable !== false;
      if (linked) {
        void check();
        return;
      }
      sequence.current++;
      setStatus('offline');
      setChecking(false);
    });

    return () => subscription.remove();
  }, [check]);

  // Only while blocked. Covers the cases the OS cannot report: a captive portal the
  // user just signed into, or the API finishing a redeploy.
  useEffect(() => {
    if (status === 'online' || status === 'checking') return;

    const timer = setInterval(() => void check(), RETRY_INTERVAL_MS);
    return () => clearInterval(timer);
  }, [status, check]);

  const value = useMemo<ConnectivityValue>(
    () => ({ status, checking, recheck: () => void check() }),
    [status, checking, check]
  );

  return <ConnectivityContext.Provider value={value}>{children}</ConnectivityContext.Provider>;
}
