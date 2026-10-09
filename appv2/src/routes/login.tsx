import { CheckCircleIcon, InfoIcon, PaletteIcon } from '@phosphor-icons/react';
import { useState } from 'react';
import { Navigate } from 'react-router';

import { AboutModal } from '@/components/about-modal';
import { AppearanceModal } from '@/components/appearance-modal';
import { RegisterForm } from '@/components/auth/register-form';
import { SignInForm } from '@/components/auth/sign-in-form';
import { ThemeToggle } from '@/components/theme-toggle';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { useAuth } from '@/features/auth/context';
import { useAppearance } from '@/lib/appearance';

type Mode = 'sign-in' | 'register';

export default function LoginScreen() {
  const { token } = useAuth();
  const { primary } = useAppearance();
  const [mode, setMode] = useState<Mode>('sign-in');
  /** The username of an account just registered, while its confirmation is showing. */
  const [registered, setRegistered] = useState<string | null>(null);
  /** Fills the sign-in form after registering, so the new username is already there. */
  const [prefill, setPrefill] = useState('');
  const [showAppearance, setShowAppearance] = useState(false);
  const [showAbout, setShowAbout] = useState(false);

  if (token) return <Navigate to="/dashboard" replace />;

  function backToSignIn() {
    setPrefill(registered ?? '');
    setRegistered(null);
    setMode('sign-in');
  }

  return (
    <div className="pt-safe pb-safe flex min-h-dvh flex-col">
      <div className="flex justify-end p-4">
        <Button
          variant="ghost"
          size="icon"
          className="size-8 rounded-full"
          aria-label="About VITAL"
          onClick={() => setShowAbout(true)}>
          <InfoIcon size={16} weight="bold" aria-hidden="true" />
        </Button>
        <Button
          variant="ghost"
          size="icon"
          className="size-8 rounded-full"
          aria-label="Appearance"
          onClick={() => setShowAppearance(true)}>
          <PaletteIcon size={16} weight="bold" aria-hidden="true" />
        </Button>
        <ThemeToggle />
      </div>

      {/* <main>, so on a phone the cards run edge to edge like the rest of the app. */}
      <main className="mx-auto flex w-full max-w-md flex-1 flex-col justify-center gap-6 px-4 pb-10 sm:px-6">
        <header className="flex flex-col items-center gap-3 text-center">
          <img
            src="/images/phinmacoc.png"
            width={80}
            height={80}
            className="size-20 object-contain"
            alt="PHINMA Cagayan de Oro College"
          />
          <div className="space-y-1">
            <h1 className="text-2xl font-bold tracking-tight">
              {registered ? 'Request sent' : mode === 'sign-in' ? 'Welcome back!' : 'Create your account'}
            </h1>
            <p className="text-muted-foreground text-sm">
              {registered
                ? 'An admin needs to approve your account first.'
                : mode === 'sign-in'
                  ? 'Sign in to monitor your 1 kVA transformer.'
                  : 'For power utility personnel.'}
            </p>
          </div>
        </header>

        {registered ? (
          <Card className="items-center gap-4 p-6 text-center">
            <span
              className="grid size-14 place-items-center rounded-full"
              style={{ backgroundColor: `${primary.hex}1f`, color: primary.hex }}>
              <CheckCircleIcon size={30} weight="fill" aria-hidden="true" />
            </span>
            <div className="space-y-1">
              <p className="text-sm">
                Your username is <span className="font-semibold">@{registered}</span>.
              </p>
              <p className="text-muted-foreground text-sm">You can sign in once an admin approves it.</p>
            </div>
            <Button className="w-full" onClick={backToSignIn}>
              Back to sign in
            </Button>
          </Card>
        ) : (
          <>
            <Card className="p-5 sm:p-6">
              {mode === 'sign-in' ? (
                <SignInForm key={prefill} initialIdentifier={prefill} />
              ) : (
                <RegisterForm onRegistered={setRegistered} />
              )}
            </Card>
            {/* A line of text rather than a control at the top: signing in is what almost
                everyone came to do, so the other way in stays out of its way. */}
            <p className="text-muted-foreground text-center text-sm">
              {mode === 'sign-in' ? "Don't have an account? " : 'Already have an account? '}
              <button
                type="button"
                className="text-primary cursor-pointer font-medium underline-offset-4 hover:underline"
                onClick={() => setMode(mode === 'sign-in' ? 'register' : 'sign-in')}>
                {mode === 'sign-in' ? 'Create one' : 'Sign in'}
              </button>
            </p>
          </>
        )}

        <p className="text-muted-foreground text-center text-[10px] uppercase tracking-widest">
          Pro Deo et Humanitate
        </p>
      </main>

      <AppearanceModal visible={showAppearance} onClose={() => setShowAppearance(false)} />
      <AboutModal visible={showAbout} onClose={() => setShowAbout(false)} />
    </div>
  );
}
