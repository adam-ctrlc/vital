import { ArrowsClockwiseIcon, DownloadSimpleIcon } from '@phosphor-icons/react';
import { useEffect, useSyncExternalStore, type ReactNode } from 'react';

import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Callout } from '@/components/ui/callout';
import { Card } from '@/components/ui/card';
import { Spinner } from '@/components/ui/spinner';
import { useAppearance } from '@/lib/appearance';
import { IS_NATIVE } from '@/lib/platform';
import { APP_VERSION } from '@/lib/updates/app-version';
import { getUpdateState, isUpdateRequired, subscribeUpdates, type UpdateState } from '@/lib/updates/store';
import { installUpdate, openApkDownload } from '@/lib/updates/updater';

/**
 * Updates are required: while one is waiting, this replaces the whole app. The ways forward
 * are Update now (download inside the app, then restart), Download (a new APK, when Android
 * itself changed) or, on the website, Reload. Offline no check succeeds, so nothing is ever
 * waiting and the app works as usual.
 */
export function UpdateGate({ children }: { children: ReactNode }) {
  const state = useSyncExternalStore(subscribeUpdates, getUpdateState);
  const blocking = isUpdateRequired(state);

  // Android's back gesture must not slip past the screen. The app's own back handler also
  // checks for a waiting update, so this only has to keep a listener registered.
  useEffect(() => {
    if (!blocking || !IS_NATIVE) return;

    let remove: (() => void) | null = null;
    let gone = false;
    void import('@capacitor/app').then(({ App }) =>
      App.addListener('backButton', () => undefined).then((handle) => {
        if (gone) void handle.remove();
        else remove = () => void handle.remove();
      })
    );

    return () => {
      gone = true;
      remove?.();
    };
  }, [blocking]);

  return blocking ? <UpdateRequired state={state} /> : <>{children}</>;
}

/** Splits release notes into a headline and bullet items ("- ", "* " or "• " lines). */
function parseNotes(notes: string): { headline: string; bullets: string[] } {
  const lines = notes
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean);
  const isBullet = (line: string) => /^[-*•]\s+/.test(line);

  return {
    headline: lines.filter((line) => !isBullet(line)).join(' '),
    bullets: lines.filter(isBullet).map((line) => line.replace(/^[-*•]\s+/, '')),
  };
}

function UpdateRequired({ state: { bundle, apk, web } }: { state: UpdateState }) {
  const { primary } = useAppearance();
  const target = bundle?.version ?? apk?.versionName ?? web?.version ?? '';
  const { headline, bullets } = parseNotes(bundle?.notes ?? apk?.notes ?? '');
  const busy = bundle?.phase === 'downloading' || bundle?.phase === 'installing';
  const percent = Math.round(bundle?.percent ?? 0);

  const lead = bundle
    ? 'A new version of VITAL is ready. It downloads inside the app; your account and settings are kept.'
    : apk
      ? 'A new version of the VITAL app is out. Download it and install it over this one.'
      : 'A new version of VITAL has been released. Reload to continue.';

  return (
    <div className="bg-background flex min-h-dvh flex-col">
      <header className="bg-card pt-safe border-b">
        <div className="flex h-14 items-center justify-center gap-2.5">
          <img src="/images/favicon.png" alt="" className="size-7 rounded-lg" />
          <span className="text-base font-semibold tracking-[0.04em]">VITAL</span>
        </div>
      </header>

      {/* <main>, so the cards run edge to edge on a phone like the rest of the app. */}
      <main className="mx-auto w-full max-w-lg flex-1 space-y-5 px-4 py-8 sm:px-6">
        <div className="flex items-start gap-4">
          <span
            className="grid size-12 shrink-0 place-items-center rounded-xl"
            style={{ backgroundColor: `${primary.hex}1f`, color: primary.hex }}>
            <DownloadSimpleIcon size={24} weight="bold" aria-hidden="true" />
          </span>
          <div className="min-w-0">
            <h1 className="text-2xl font-bold tracking-tight">Update required</h1>
            <p className="text-muted-foreground mt-1 text-sm leading-relaxed">{lead}</p>
          </div>
        </div>

        <Card className="gap-0 divide-y overflow-hidden py-0" aria-label="Versions">
          <div className="flex items-center justify-between px-4 py-3.5 text-sm">
            <span className="text-muted-foreground">Your version</span>
            <span className="font-medium tabular-nums">v{APP_VERSION}</span>
          </div>
          <div className="flex items-center justify-between px-4 py-3.5 text-sm">
            <span className="text-muted-foreground">New version</span>
            <Badge className="normal-case tracking-normal">v{target}</Badge>
          </div>
        </Card>

        {headline || bullets.length > 0 ? (
          <Card className="gap-0 overflow-hidden py-0" aria-labelledby="whats-new">
            <h2 id="whats-new" className="border-b px-4 py-3.5 text-sm font-semibold">
              What's new
            </h2>
            <div className="space-y-3 px-4 py-4">
              {headline ? <p className="text-sm font-medium">{headline}</p> : null}
              {bullets.length > 0 ? (
                <ul className="space-y-2.5">
                  {bullets.map((item) => (
                    <li key={item} className="text-muted-foreground flex gap-3 text-sm leading-relaxed">
                      <span
                        aria-hidden="true"
                        className="mt-[0.55rem] size-1.5 shrink-0 rounded-full"
                        style={{ backgroundColor: primary.hex }}
                      />
                      {item}
                    </li>
                  ))}
                </ul>
              ) : null}
            </div>
          </Card>
        ) : null}
      </main>

      {/* The action, pinned to the bottom within thumb reach. */}
      <div className="bg-card pb-safe sticky bottom-0 border-t">
        <div className="mx-auto max-w-lg space-y-3 px-4 py-4 sm:px-6">
          {bundle?.phase === 'downloading' ? (
            <div aria-live="polite" className="space-y-2">
              <div className="flex justify-between text-sm">
                <span className="font-medium">Downloading update…</span>
                <span className="text-muted-foreground tabular-nums">{percent}%</span>
              </div>
              <div
                role="progressbar"
                aria-label="Download progress"
                aria-valuemin={0}
                aria-valuemax={100}
                aria-valuenow={percent}
                className="bg-muted h-2 overflow-hidden rounded-full">
                <div
                  className="h-full rounded-full transition-[width] duration-300"
                  style={{ width: `${percent}%`, backgroundColor: primary.hex }}
                />
              </div>
            </div>
          ) : null}
          {bundle?.phase === 'installing' ? <Callout tone="info" title="Installing. VITAL restarts in a moment." /> : null}
          {bundle?.phase === 'failed' ? (
            <Callout tone="destructive" title="The download didn't finish" description="Check your connection and try again." />
          ) : null}

          {bundle ? (
            <Button size="lg" className="w-full" disabled={busy} onClick={() => void installUpdate()}>
              {busy ? (
                <>
                  <Spinner className="size-4" />
                  {bundle.phase === 'installing' ? 'Restarting…' : `Downloading… ${percent}%`}
                </>
              ) : (
                <>
                  <DownloadSimpleIcon weight="bold" aria-hidden="true" />
                  {bundle.phase === 'failed' ? 'Try again' : 'Update now'}
                </>
              )}
            </Button>
          ) : apk ? (
            <Button size="lg" className="w-full" onClick={() => openApkDownload(apk.url)}>
              <DownloadSimpleIcon weight="bold" aria-hidden="true" />
              Download
            </Button>
          ) : (
            <Button size="lg" className="w-full" onClick={() => window.location.reload()}>
              <ArrowsClockwiseIcon weight="bold" aria-hidden="true" />
              Reload
            </Button>
          )}

          {bundle && apk && !busy ? (
            <Button variant="outline" className="w-full" onClick={() => openApkDownload(apk.url)}>
              Also download app version {apk.versionName}
            </Button>
          ) : null}
          {apk && !bundle ? (
            <p className="text-muted-foreground text-center text-xs">
              Your browser downloads the app. Open the file to install it.
            </p>
          ) : null}
        </div>
      </div>
    </div>
  );
}
