import { Card } from '@/components/ui/card';
import { Skeleton } from '@/components/ui/skeleton';

const ROWS = [0, 1, 2, 3, 4, 5, 6, 7];

/** Mirrors the records table so the page does not jump when data lands. */
export function LogListSkeleton() {
  return (
    <Card className="gap-0 overflow-hidden py-0" aria-busy="true" aria-label="Loading records">
      <div className="bg-muted border-b px-4 py-3">
        <Skeleton className="h-2.5 w-2/3" />
      </div>
      <div className="divide-y">
        {ROWS.map((row) => (
          <div key={row} className="flex items-center gap-4 px-4 py-3">
            <Skeleton className="h-3 w-24" />
            <Skeleton className="h-3 w-10" />
            <Skeleton className="h-3 w-14" />
            <Skeleton className="h-3 flex-1" />
          </div>
        ))}
      </div>
    </Card>
  );
}
