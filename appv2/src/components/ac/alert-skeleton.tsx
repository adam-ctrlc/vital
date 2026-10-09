import { Card } from '@/components/ui/card';
import { Skeleton } from '@/components/ui/skeleton';

const ROWS = [0, 1, 2, 3];

/** Mirrors the real alert card so the list does not jump when data lands. */
function AlertCardSkeleton() {
  return (
    <Card className="gap-2 p-4">
      <div className="flex items-center gap-2">
        <Skeleton className="size-8 rounded-full" />
        <div className="flex flex-1 flex-col gap-1">
          <Skeleton className="h-3.5 w-24" />
          <Skeleton className="h-2.5 w-32" />
        </div>
        <Skeleton className="h-5 w-16 rounded-full" />
      </div>
      <Skeleton className="h-6 w-28" />
      <Skeleton className="h-3.5 w-full" />
      <Skeleton className="h-9 w-full rounded-md" />
    </Card>
  );
}

export function AlertListSkeleton() {
  return (
    <div className="flex flex-col gap-3" aria-busy="true" aria-label="Loading alerts">
      {ROWS.map((row) => (
        <AlertCardSkeleton key={row} />
      ))}
    </div>
  );
}
