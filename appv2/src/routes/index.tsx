import { Navigate } from 'react-router';

import { AppLoading } from '@/components/app-loading';
import { useAuth } from '@/features/auth/context';

export default function Index() {
  const { token, loading } = useAuth();

  if (loading) return <AppLoading message="Signing you in…" />;

  return <Navigate to={token ? '/dashboard' : '/login'} replace />;
}
