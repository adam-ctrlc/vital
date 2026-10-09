import { ArrowsClockwiseIcon, ChartBarIcon, type Icon } from '@phosphor-icons/react';
import type { ReactNode } from 'react';
import { Navigate } from 'react-router';

import { RangeBar } from '@/components/analysis/range-bar';
import { Button } from '@/components/ui/button';
import { Callout } from '@/components/ui/callout';
import { Card } from '@/components/ui/card';
import { EmptyState } from '@/components/ui/empty-state';
import { PageHeader } from '@/components/ui/page-header';
import { Skeleton } from '@/components/ui/skeleton';
import { useAuth } from '@/features/auth/context';
import { useAnalysisRange, type AnalysisRange } from '@/features/insights/range';
import type { Insights } from '@/features/insights/types';
import { useInsights } from '@/features/insights/use-insights';
import { useAppearance } from '@/lib/appearance';
import { cn } from '@/lib/utils';

export const BACK_TO_SETTINGS = { to: '/settings', label: 'Back to settings', mobileOnly: true };

export function AdminOnly({ children }: { children: ReactNode }) {
  const { token, user } = useAuth();
  if (!token) return <Navigate to="/login" replace />;
  if (user && user.role !== 'admin') return <Navigate to="/dashboard" replace />;
  return <>{children}</>;
}

function DataSkeleton() {
  return (
    <div className="space-y-4" aria-label="Loading">
      <Card className="grid grid-cols-2 gap-4 p-4 sm:grid-cols-4">
        {Array.from({ length: 4 }, (_, i) => (
          <div key={i} className="space-y-2">
            <Skeleton className="h-3 w-16" />
            <Skeleton className="h-6 w-24" />
          </div>
        ))}
      </Card>
      <Card className="gap-3 p-4">
        <Skeleton className="h-4 w-32" />
        <Skeleton className="h-36 w-full" />
      </Card>
    </div>
  );
}

/** The frame every analysis page shares: header, range, and the loading, empty and error states. */
export function AnalysisPage({
  icon,
  title,
  children,
}: {
  icon: Icon;
  title: string;
  children: (data: Insights, context: { range: AnalysisRange; reload: () => void }) => ReactNode;
}) {
  const { primary } = useAppearance();
  const [range, setRange] = useAnalysisRange();
  const { data, error, loading, reload } = useInsights(range);
  const empty = data !== null && data.samples === 0;

  return (
    <AdminOnly>
      <PageHeader
        icon={icon}
        iconColor={primary.hex}
        title={title}
        back={BACK_TO_SETTINGS}
        actions={
          <Button variant="ghost" size="icon" className="size-8 rounded-full" aria-label="Refresh" disabled={loading} onClick={reload}>
            <ArrowsClockwiseIcon weight="bold" className={cn(loading && 'animate-spin')} aria-hidden="true" />
          </Button>
        }
      />
      <RangeBar value={range} onChange={setRange} />
      {error ? <Callout tone="destructive" title="Could not load this page" description={error} /> : null}
      {loading ? <DataSkeleton /> : null}
      {!loading && empty ? (
        <EmptyState icon={ChartBarIcon} title="No readings in this range" description="Try a longer range or another source." />
      ) : null}
      {!loading && data && !empty ? children(data, { range, reload }) : null}
    </AdminOnly>
  );
}
