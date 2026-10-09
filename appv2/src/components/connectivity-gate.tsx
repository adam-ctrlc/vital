import { ArrowsClockwiseIcon, CloudSlashIcon, WifiSlashIcon } from '@phosphor-icons/react';
import { type ReactNode } from 'react';

import { Button } from '@/components/ui/button';
import { AppLoading } from '@/components/app-loading';
import { Spinner } from '@/components/ui/spinner';
import { useConnectivity } from '@/features/connectivity/context';

const COPY = {
  offline: {
    icon: WifiSlashIcon,
    title: 'No internet connection',
    description: 'VITAL needs a connection to read the transformer. This clears on its own once you are back online.',
  },
  unreachable: {
    icon: CloudSlashIcon,
    title: 'Cannot reach VITAL',
    description: 'You are online, but the server is not answering. Retrying every few seconds.',
  },
} as const;

/**
 * Holds the app closed until there is a connection that can carry data. Not dismissible:
 * every page is a live read of the API, and a dashboard of empty dashes with no reason
 * given looks like a calm transformer.
 */
export function ConnectivityGate({ children }: { children: ReactNode }) {
  const { status, checking, recheck } = useConnectivity();

  if (status === 'online') return <>{children}</>;

  // First launch, before any verdict: a spinner, so a slow cold start does not accuse the
  // network of being broken.
  if (status === 'checking') return <AppLoading message="Connecting…" />;

  const { icon: StateIcon, title, description } = COPY[status];

  return (
    <div className="grid min-h-dvh place-items-center p-8">
      <div className="flex w-full max-w-sm flex-col items-center gap-6 text-center">
        <StateIcon size={88} weight="duotone" className="text-zinc-300 dark:text-zinc-600" aria-hidden="true" />
        <div className="space-y-2">
          <h1 className="text-xl font-semibold">{title}</h1>
          <p className="text-muted-foreground text-sm leading-5">{description}</p>
        </div>
        <Button className="w-full" disabled={checking} onClick={recheck}>
          {checking ? <Spinner className="size-4" /> : <ArrowsClockwiseIcon weight="bold" aria-hidden="true" />}
          {checking ? 'Checking...' : 'Try again'}
        </Button>
      </div>
    </div>
  );
}
