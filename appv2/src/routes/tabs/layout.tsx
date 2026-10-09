import {
  BellIcon,
  ChartLineIcon,
  GaugeIcon,
  GearIcon,
  SignOutIcon,
  UserCircleIcon,
  UsersIcon,
  type Icon,
} from '@phosphor-icons/react';
import { useCallback, useEffect, useState } from 'react';
import { Link, Navigate, NavLink, Outlet, useLocation } from 'react-router';

import { ConfirmModal } from '@/components/confirm-modal';
import { TabIcon } from '@/components/tab-icon';
import { AppLoading } from '@/components/app-loading';
import { useAuth } from '@/features/auth/context';
import { NotificationsProvider, useNotifications } from '@/features/notifications/context';
import * as usersApi from '@/features/users/api';
import { usePoll } from '@/hooks/use-poll';
import { useAppearance } from '@/lib/appearance';
import { cn } from '@/lib/utils';

type Tab = {
  to: string;
  title: string;
  icon: Icon;
  adminOnly?: boolean;
  dot?: 'alerts' | 'logs' | 'pending';
  /** Other paths that belong to this tab, such as a page opened from it. */
  also?: string[];
};

const TABS: Tab[] = [
  { to: '/dashboard', title: 'Monitor', icon: GaugeIcon },
  { to: '/alerts', title: 'Alerts', icon: BellIcon, dot: 'alerts' },
  { to: '/logs', title: 'Logs', icon: ChartLineIcon, adminOnly: true, dot: 'logs' },
  { to: '/settings', title: 'Settings', icon: GearIcon, adminOnly: true, also: ['/users'], dot: 'pending' },
  { to: '/profile', title: 'Profile', icon: UserCircleIcon },
];

/** The sidebar's groups. Wider than the tab bar, so it can name and group things. */
const SIDEBAR: { title: string; adminOnly?: boolean; items: (Tab & { count?: 'alerts' | 'logs' | 'pending' })[] }[] = [
  {
    title: 'Monitoring',
    items: [
      { to: '/dashboard', title: 'Monitor', icon: GaugeIcon },
      { to: '/alerts', title: 'Alerts', icon: BellIcon, count: 'alerts' },
      { to: '/logs', title: 'Logs', icon: ChartLineIcon, adminOnly: true, count: 'logs' },
    ],
  },
  {
    title: 'Manage',
    adminOnly: true,
    items: [
      { to: '/settings', title: 'Settings', icon: GearIcon },
      { to: '/users', title: 'User accounts', icon: UsersIcon, count: 'pending' },
    ],
  },
  {
    title: 'Account',
    items: [{ to: '/profile', title: 'Profile', icon: UserCircleIcon }],
  },
];

const ROLE_TITLE = { admin: 'Maintenance Engineer', user: 'Power Utility Personnel' } as const;

/** How often an admin's shell checks for sign-ups waiting on approval. */
const PENDING_POLL_MS = 60_000;

/** Where the ids of sign-ups this device has already shown on User accounts are kept. */
const SEEN_KEY = 'vital.seen-pending-accounts';

function loadSeen(): Set<string> {
  try {
    return new Set(JSON.parse(localStorage.getItem(SEEN_KEY) ?? '[]') as string[]);
  } catch {
    return new Set();
  }
}

/**
 * Sign-ups waiting for an admin that this admin has not looked at yet. Opening User
 * accounts marks every waiting one as seen, so the badge clears there and comes back only
 * for a new request. Always 0 for a user, who cannot list accounts at all.
 */
function useUnseenPending(isAdmin: boolean, viewing: boolean): number {
  const { token } = useAuth();
  const fetcher = useCallback(
    (signal: AbortSignal) => usersApi.list(token ?? '', { status: 'pending' }, signal),
    [token]
  );
  // Polled faster while the list is open, so a request approved or rejected there is not
  // still counted when the admin leaves.
  const { data } = usePoll(fetcher, viewing ? 5_000 : PENDING_POLL_MS, isAdmin && Boolean(token));
  const [seen, setSeen] = useState(loadSeen);

  const pendingIds = (data ?? []).map((account) => account.id);
  const key = pendingIds.join(',');

  useEffect(() => {
    if (!viewing || key === '') return;
    setSeen((current) => {
      if (pendingIds.every((id) => current.has(id))) return current;
      // Only ids still pending are kept, so the stored list cannot grow forever.
      const next = new Set(pendingIds);
      try {
        localStorage.setItem(SEEN_KEY, JSON.stringify([...next]));
      } catch {
        // Storage blocked: the badge just comes back after a reload.
      }
      return next;
    });
    // `key` stands in for the ids array, which is new on every render.
  }, [viewing, key]);

  return isAdmin && !viewing ? pendingIds.filter((id) => !seen.has(id)).length : 0;
}

export default function TabsLayout() {
  const { token, user, loading } = useAuth();
  const isAdmin = user?.role === 'admin';

  if (loading) return <AppLoading message="Signing you in…" />;

  if (!token) return <Navigate to="/login" replace />;

  return (
    <NotificationsProvider watchLogs={isAdmin}>
      <Shell isAdmin={isAdmin} />
    </NotificationsProvider>
  );
}

/**
 * Bottom tabs on a phone, a fixed sidebar on a wide window. The page itself scrolls with
 * the document; <main> is the one container every page renders into, so content never
 * shifts between routes.
 */
function Shell({ isAdmin }: { isAdmin: boolean }) {
  const { primary } = useAppearance();
  const { activeAlerts, newOverloads } = useNotifications();
  const { pathname } = useLocation();
  const pendingAccounts = useUnseenPending(isAdmin, pathname === '/users');

  const tabs = TABS.filter((tab) => isAdmin || !tab.adminOnly);
  const isActive = (tab: Tab) => pathname === tab.to || (tab.also ?? []).includes(pathname);
  const hasDot = (tab: Tab) =>
    tab.dot === 'alerts'
      ? activeAlerts > 0
      : tab.dot === 'logs'
        ? newOverloads > 0
        : tab.dot === 'pending'
          ? pendingAccounts > 0
          : false;

  return (
    <div className="min-h-dvh md:pl-64">
      <aside className="bg-card fixed inset-y-0 left-0 z-30 hidden w-64 border-r md:block">
        <Sidebar isAdmin={isAdmin} pendingAccounts={pendingAccounts} />
      </aside>

      <main className="pt-safe mx-auto w-full max-w-3xl px-4 pb-[calc(5.5rem+env(safe-area-inset-bottom))] sm:px-6 md:pb-12">
        <div className="flex flex-col gap-4 pt-4 md:pt-8">
          <Outlet />
        </div>
      </main>

      <nav
        aria-label="Main"
        className="bg-card/95 pb-safe fixed inset-x-0 bottom-0 z-20 border-t backdrop-blur md:hidden">
        <div className="mx-auto grid max-w-lg" style={{ gridTemplateColumns: `repeat(${tabs.length}, 1fr)` }}>
          {tabs.map((tab) => {
            const active = isActive(tab);
            return (
              <NavLink
                key={tab.to}
                to={tab.to}
                className={cn(
                  'flex h-14 flex-col items-center justify-center gap-0.5 text-[10px] font-medium',
                  !active && 'text-muted-foreground'
                )}
                style={active ? { color: primary.hex } : undefined}
                aria-current={active ? 'page' : undefined}>
                <TabIcon icon={tab.icon} dot={hasDot(tab)} />
                {tab.title}
              </NavLink>
            );
          })}
        </div>
      </nav>
    </div>
  );
}

/** The desktop sidebar: grouped links, and the signed-in account with sign out at the foot. */
function Sidebar({ isAdmin, pendingAccounts }: { isAdmin: boolean; pendingAccounts: number }) {
  const { user, signOut } = useAuth();
  const { primary } = useAppearance();
  const { activeAlerts, newOverloads } = useNotifications();
  const { pathname } = useLocation();
  const [confirming, setConfirming] = useState(false);

  const initials =
    `${user?.firstName?.[0] ?? ''}${user?.lastName?.[0] ?? ''}`.toUpperCase() ||
    (user?.username?.[0] ?? '?').toUpperCase();

  return (
    <div className="pt-safe pb-safe flex h-full flex-col">
      <Link to="/dashboard" className="flex h-16 items-center gap-2.5 px-5">
        <img src="/images/favicon.png" alt="" className="size-8 rounded-lg" />
        <span className="leading-tight">
          <span className="block text-base font-semibold tracking-[0.04em]">VITAL</span>
          <span className="text-muted-foreground block text-[11px]">1 kVA transformer</span>
        </span>
      </Link>

      <nav aria-label="Main" className="flex-1 space-y-5 overflow-y-auto px-3 pt-3">
        {SIDEBAR.filter((group) => isAdmin || !group.adminOnly).map((group) => (
          <div key={group.title} className="space-y-0.5">
            <p className="text-muted-foreground px-3 pb-1 text-xs font-medium">
              {group.title}
            </p>
            {group.items
              .filter((item) => isAdmin || !item.adminOnly)
              .map((item) => {
                const active = pathname === item.to;
                const count =
                  item.count === 'alerts'
                    ? activeAlerts
                    : item.count === 'logs'
                      ? newOverloads
                      : item.count === 'pending'
                        ? pendingAccounts
                        : 0;
                const ItemIcon = item.icon;

                return (
                  <NavLink
                    key={item.to}
                    to={item.to}
                    aria-current={active ? 'page' : undefined}
                    className={cn(
                      'flex h-9 items-center gap-3 rounded-md px-3 text-sm font-medium transition-colors',
                      active ? 'bg-accent text-foreground' : 'text-muted-foreground hover:bg-accent/60 hover:text-foreground'
                    )}>
                    <ItemIcon
                      size={18}
                      weight={active ? 'fill' : 'bold'}
                      color={active ? primary.hex : undefined}
                      aria-hidden="true"
                    />
                    <span className="flex-1">{item.title}</span>
                    {count > 0 ? (
                      <span
                        aria-label={`${count} new`}
                        className="bg-destructive grid h-5 min-w-5 place-items-center rounded-full px-1.5 text-[11px] font-semibold tabular-nums text-white">
                        {count > 99 ? '99+' : count}
                      </span>
                    ) : null}
                  </NavLink>
                );
              })}
          </div>
        ))}
      </nav>

      <div className="space-y-0.5 border-t p-3">
        <Link
          to="/profile"
          className="hover:bg-accent/60 flex items-center gap-3 rounded-md p-2 transition-colors">
          <span
            aria-hidden="true"
            className="grid size-9 shrink-0 place-items-center rounded-full text-xs font-bold"
            style={{ backgroundColor: `${primary.hex}1f`, color: primary.hex }}>
            {initials}
          </span>
          <span className="min-w-0 flex-1">
            <span className="block text-sm font-semibold leading-tight">{user?.fullName || user?.username}</span>
            <span className="text-muted-foreground block text-xs">{user ? ROLE_TITLE[user.role] : ''}</span>
          </span>
        </Link>
        <button
          type="button"
          onClick={() => setConfirming(true)}
          className="text-muted-foreground hover:bg-destructive/10 hover:text-destructive flex h-9 w-full cursor-pointer items-center gap-3 rounded-md px-3 text-sm font-medium transition-colors">
          <SignOutIcon size={18} weight="bold" aria-hidden="true" />
          Sign out
        </button>
      </div>

      <ConfirmModal
        visible={confirming}
        title="Sign out?"
        message="You will need your email and password to sign back in."
        confirmLabel="Sign out"
        destructive
        onConfirm={() => {
          setConfirming(false);
          void signOut();
        }}
        onClose={() => setConfirming(false)}
      />
    </div>
  );
}
