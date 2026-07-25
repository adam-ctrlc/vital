import * as SecureStore from 'expo-secure-store';
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from 'react';

import * as api from '@/features/auth/api';
import type { Role, User } from '@/features/auth/types';
import { ApiError, setUnauthorizedHandler } from '@/lib/api-client';

const TOKEN_KEY = 'dynavolt.token';

type AuthValue = {
  token: string | null;
  user: User | null;
  loading: boolean;
  signIn: (email: string, password: string, role?: Role) => Promise<void>;
  signOut: () => Promise<void>;
  /** Replaces the cached account after the API returns an updated one. */
  setUser: (user: User) => void;
};

const AuthContext = createContext<AuthValue | null>(null);

export function useAuth() {
  const value = useContext(AuthContext);
  if (!value) {
    throw new Error('useAuth must be used within an AuthProvider');
  }
  return value;
}

export function AuthProvider({ children }: { children: ReactNode }) {
  const [token, setToken] = useState<string | null>(null);
  const [user, setUser] = useState<User | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let active = true;

    async function restore() {
      try {
        const stored = await SecureStore.getItemAsync(TOKEN_KEY);
        if (!stored) return;

        const found = await api.profile(stored);
        if (active) {
          setToken(stored);
          setUser(found);
        }
      } catch (caught) {
        // Only a rejected token is a reason to throw the session away. Airplane mode,
        // a DNS failure and a Vercel 502 all land here too, and discarding a token
        // that is still valid for hours over a dead signal forces a needless re-login
        // in exactly the place the app is used.
        if (caught instanceof ApiError && caught.status === 401) {
          await SecureStore.deleteItemAsync(TOKEN_KEY);
        }
      } finally {
        if (active) setLoading(false);
      }
    }

    void restore();

    return () => {
      active = false;
    };
  }, []);

  const signIn = useCallback(async (email: string, password: string, role?: Role) => {
    const result = await api.login(email, password, role);
    await SecureStore.setItemAsync(TOKEN_KEY, result.token);
    setToken(result.token);
    setUser(result.user);
  }, []);

  const signOut = useCallback(async () => {
    // State first: if the keychain throws (locked, or invalidated by a PIN change on
    // Android) the caller still ends up signed out rather than stuck on a screen that
    // says nothing happened.
    setToken(null);
    setUser(null);
    await SecureStore.deleteItemAsync(TOKEN_KEY);
  }, []);

  // Ends the session as soon as the server rejects the token, instead of letting the
  // pollers retry a dead token until someone signs out by hand.
  useEffect(() => {
    setUnauthorizedHandler(() => {
      void signOut();
    });

    return () => setUnauthorizedHandler(null);
  }, [signOut]);

  const value = useMemo<AuthValue>(
    () => ({ token, user, loading, signIn, signOut, setUser }),
    [token, user, loading, signIn, signOut]
  );

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}
