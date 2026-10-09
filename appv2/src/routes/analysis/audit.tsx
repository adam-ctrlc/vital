import { ClipboardTextIcon, GearIcon, PowerIcon, UserCircleIcon, UsersIcon, type Icon } from '@phosphor-icons/react';
import { useEffect, useState } from 'react';

import { AdminOnly, BACK_TO_SETTINGS } from '@/components/analysis/analysis-page';
import { Callout } from '@/components/ui/callout';
import { Card } from '@/components/ui/card';
import { EmptyState } from '@/components/ui/empty-state';
import { PageHeader } from '@/components/ui/page-header';
import { Pager } from '@/components/ui/pager';
import { Segmented } from '@/components/ui/segmented';
import { Skeleton } from '@/components/ui/skeleton';
import * as auditApi from '@/features/audit/api';
import { auditCategory, describeAction } from '@/features/audit/describe';
import type { AuditEvent, AuditFilter } from '@/features/audit/types';
import { useAuth } from '@/features/auth/context';
import { useAppearance } from '@/lib/appearance';
import { formatShortDateTime } from '@/lib/datetime';
import { PAGE_SIZE } from '@/lib/pagination';

const FILTERS: { label: string; value: AuditFilter }[] = [
  { label: 'All', value: null },
  { label: 'Settings', value: 'settings' },
  { label: 'Relay', value: 'relay' },
  { label: 'Users', value: 'user' },
  { label: 'Account', value: 'account' },
];

const ICON: Record<ReturnType<typeof auditCategory>, Icon> = {
  settings: GearIcon,
  relay: PowerIcon,
  user: UsersIcon,
  account: UserCircleIcon,
  other: ClipboardTextIcon,
};

export default function AuditScreen() {
  const { token } = useAuth();
  const { primary } = useAppearance();
  const [filter, setFilter] = useState<AuditFilter>(null);
  const [offset, setOffset] = useState(0);
  const [rows, setRows] = useState<AuditEvent[]>([]);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => setOffset(0), [filter]);

  useEffect(() => {
    if (!token) return;
    const controller = new AbortController();
    setLoading(true);
    auditApi
      .list(token, { limit: PAGE_SIZE, offset, action: filter }, controller.signal)
      .then((page) => {
        setRows(page.rows);
        setTotal(page.total);
        setError(null);
      })
      .catch((caught: Error) => {
        if (caught.name !== 'AbortError') setError(caught.message);
      })
      .finally(() => {
        if (!controller.signal.aborted) setLoading(false);
      });
    return () => controller.abort();
  }, [token, offset, filter]);

  return (
    <AdminOnly>
      <PageHeader icon={ClipboardTextIcon} iconColor={primary.hex} title="Audit log" back={BACK_TO_SETTINGS} />
      <div className="-mx-4 overflow-x-auto px-4 sm:mx-0 sm:px-0">
        <Segmented aria-label="Show" options={FILTERS} value={filter} onValueChange={setFilter} size="sm" />
      </div>
      {error ? <Callout tone="destructive" title="Could not load the audit log" description={error} /> : null}

      {loading ? (
        <Card className="gap-0 divide-y py-0" aria-label="Loading">
          {Array.from({ length: 6 }, (_, i) => (
            <div key={i} className="flex items-center gap-3 px-4 py-3">
              <Skeleton className="size-9 rounded-full" />
              <div className="flex-1 space-y-2">
                <Skeleton className="h-3.5 w-3/4" />
                <Skeleton className="h-3 w-24" />
              </div>
            </div>
          ))}
        </Card>
      ) : rows.length === 0 && !error ? (
        <EmptyState icon={ClipboardTextIcon} title="Nothing recorded yet" description="Changes to settings, the relay and accounts show up here." />
      ) : (
        <Card className="gap-0 divide-y py-0">
          {rows.map((event) => {
            const RowIcon = ICON[auditCategory(event.action)];
            return (
              <div key={event.id} className="flex items-start gap-3 px-4 py-3">
                <span className="bg-accent grid size-9 shrink-0 place-items-center rounded-full">
                  <RowIcon size={16} weight="bold" color={primary.hex} aria-hidden="true" />
                </span>
                <div className="min-w-0 flex-1">
                  <p className="text-sm">
                    <span className="font-semibold">{event.actorName ?? 'Someone'}</span> {describeAction(event)}
                  </p>
                  <time dateTime={event.at} className="text-muted-foreground text-xs">
                    {formatShortDateTime(event.at)}
                  </time>
                </div>
              </div>
            );
          })}
        </Card>
      )}

      {!loading ? <Pager total={total} limit={PAGE_SIZE} offset={offset} onOffsetChange={setOffset} noun="change" /> : null}
    </AdminOnly>
  );
}
