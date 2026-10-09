/**
 * The full-screen loading state while the app starts: the logo, a line saying what it is
 * waiting on, and a progress bar that keeps moving. The same markup is written into
 * index.html, so the page looks like this from the first paint and React takes over
 * without a flash.
 */
export function AppLoading({ message = 'Loading…' }: { message?: string }) {
  return (
    <div role="status" aria-live="polite" className="bg-background grid min-h-dvh place-items-center p-8">
      <div className="flex flex-col items-center gap-5">
        <img src="/images/favicon.png" alt="" className="loading-logo size-16 rounded-2xl shadow-sm" />
        <div className="flex flex-col items-center gap-1">
          <span className="text-lg font-semibold tracking-[0.04em]">VITAL</span>
          <span className="text-muted-foreground text-sm">{message}</span>
        </div>
        <div className="bg-muted h-1 w-40 overflow-hidden rounded-full" aria-hidden="true">
          <div className="loading-bar bg-primary h-full w-1/3 rounded-full" />
        </div>
      </div>
    </div>
  );
}
