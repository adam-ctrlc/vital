import { BellIcon, ChartLineIcon, GaugeIcon, GearIcon, LightningIcon, PaletteIcon, PlugsConnectedIcon, PulseIcon, SunIcon, ThermometerIcon, UserCircleIcon, WarningIcon, WaveSineIcon, type Icon } from '@phosphor-icons/react';
import { lazy, Suspense, useState, type ComponentProps } from 'react';

import { BottomSheet } from '@/components/bottom-sheet';
import type { FormulaName } from '@/components/formula';
import { Segmented } from '@/components/ui/segmented';
import { useAuth } from '@/features/auth/context';
import { useAppearance, useColorScheme } from '@/lib/appearance';
import { cn } from '@/lib/utils';

// KaTeX is a third of the app's weight and only this sheet uses it, so it loads when the
// sheet first opens rather than with the app.
const LazyFormula = lazy(() => import('@/components/formula').then((module) => ({ default: module.Formula })));

function Formula(props: ComponentProps<typeof LazyFormula>) {
  return (
    <Suspense fallback={null}>
      <LazyFormula {...props} />
    </Suspense>
  );
}

type Tab = 'usage' | 'readings';

const TABS = [
  { label: 'Using the app', value: 'usage' as Tab, icon: GaugeIcon },
  { label: 'The readings', value: 'readings' as Tab, icon: WaveSineIcon },
];

function IconItem({
  icon: ItemIcon,
  color,
  title,
  unit,
  unitColor,
  children,
}: {
  icon: Icon;
  color: string;
  title: string;
  unit?: FormulaName;
  unitColor?: string;
  children: string;
}) {
  return (
    <div className="flex gap-3">
      <span className="bg-accent mt-0.5 grid size-8 shrink-0 place-items-center rounded-lg">
        <ItemIcon size={18} weight="bold" color={color} aria-hidden="true" />
      </span>
      <div className="flex min-w-0 flex-1 flex-col gap-0.5">
        <div className="flex items-center gap-1.5">
          <h4 className="font-semibold">{title}</h4>
          {unit && unitColor ? (
            <Formula name={unit} color={unitColor} fontSize={15} width={84} />
          ) : null}
        </div>
        <p className="text-muted-foreground text-sm leading-5">
          {children}
        </p>
      </div>
    </div>
  );
}

function SectionTitle({ children }: { children: string }) {
  return <h3 className="text-muted-foreground text-xs uppercase tracking-wide">{children}</h3>;
}

type Colors = { ac: string; fg: string; muted: string; amber: string; danger: string };

/** What each screen is for. Only the screens the signed-in role can open are listed. */
function UsageTab({ isAdmin, colors }: { isAdmin: boolean; colors: Colors }) {
  const { ac, fg, amber, danger } = colors;

  return (
    <>
      <p className="text-muted-foreground text-sm leading-5">
        {isAdmin
          ? 'You are signed in as a maintenance engineer, so every screen is open to you.'
          : 'You are signed in as power utility personnel: monitoring and alerts. Logs and settings are for maintenance engineers.'}
      </p>

      <div className="flex flex-col gap-3">
        <SectionTitle>Screens</SectionTitle>

        <IconItem icon={GaugeIcon} color={ac} title="Monitor">
          The live view. The big number is apparent power in VA, judged against the load
          threshold. Below it are current, voltage and temperature, then the metering
          panel.
        </IconItem>

        <IconItem icon={BellIcon} color={danger} title="Alerts">
          Opens on active alerts only. Acknowledge one to record who responded and how long it
          took. Switch to All to see acknowledged ones, and filter by kind or search the message.
        </IconItem>

        {isAdmin ? (
          <IconItem icon={ChartLineIcon} color={ac} title="Logs">
            Every stored reading, newest first. Search by status, source, power or date, filter to
            overloads, and page through. The bar chart shows the daily average load, with the dashed
            line marking that day's peak.
          </IconItem>
        ) : null}

        {isAdmin ? (
          <IconItem icon={GearIcon} color={ac} title="Settings">
            Set the alarm, trip and temperature thresholds every reading is judged against, switch
            between the simulation and the board, and manage the ESP32: its link state and live
            telemetry.
          </IconItem>
        ) : null}

        <IconItem icon={UserCircleIcon} color={ac} title="Profile">
          Edit your name, change your password, set up notifications and sign out. Your access
          level is set by an admin.
        </IconItem>
      </div>

      <div className="flex flex-col gap-3">
        <SectionTitle>Alerts</SectionTitle>
        <IconItem icon={WarningIcon} color={danger} title="When one is raised">
          Automatically, the moment a reading reaches a threshold. A red dot appears on the Alerts
          tab while any alert is still unacknowledged.
        </IconItem>
        <p className="text-muted-foreground text-sm leading-5">
          {isAdmin
            ? 'A repeat of the same kind does not stack: while one is unacknowledged, no duplicate is raised. The Logs tab also shows a red dot when new overloads are recorded.'
            : 'A repeat of the same kind does not stack: while one is unacknowledged, no duplicate is raised.'}
        </p>
      </div>

      <div className="flex flex-col gap-3">
        <SectionTitle>Protection</SectionTitle>
        <p className="text-muted-foreground text-sm leading-5">
          There are two load levels, and they do different things. The alarm only tells you: it
          raises an alert and marks the reading as an overload, but the transformer keeps
          supplying. The trip sits above it and is what actually cuts the load, so somebody has
          a window to shed load themselves before the board does it for them.
        </p>
        <IconItem icon={PlugsConnectedIcon} color={amber} title="When the load is cut">
          The load has to stay above the trip level, or at 9.09 A or more, for the trip delay
          first (2 seconds unless changed in Settings), so a motor starting up cannot cut the supply. A shorter delay
          cuts a real fault sooner; a longer one rides out a brief surge. An admin can switch it
          back on from Settings.
        </IconItem>
        <IconItem icon={PlugsConnectedIcon} color={amber} title="Instant trip">
          At 90.91 A or more the relay opens at once, with no delay, and stays off until an admin
          switches it back on. If the current is still that high, it opens again within a second.
        </IconItem>
        <IconItem icon={PlugsConnectedIcon} color={ac} title="When it comes back">
          Once the load is back under the alarm level and the reclose delay has passed (30
          seconds unless changed). It will not restore while the load is merely off the trip
          point, or while the energy meter is unreadable, because the board cannot confirm the
          fault is gone.
        </IconItem>
        <IconItem icon={WarningIcon} color={danger} title="Locked out">
          After three reclose attempts the board stops trying and holds the relay open until an
          admin closes it from Settings. Check the transformer before you do.
        </IconItem>
        <p className="text-muted-foreground text-sm leading-5">
          The On and Off buttons never defeat the protection: an overload re-opens the contacts a
          few seconds later, whoever closed them. All of this runs on the board itself, so it
          still protects the transformer when the Wi-Fi is down or the app is closed, and a trip
          survives a reboot.
        </p>
      </div>

      <div className="flex flex-col gap-3">
        <SectionTitle>Notifications</SectionTitle>
        <p className="text-muted-foreground text-sm leading-5">
          Set in Profile, and they apply to this device only. Turning them off stops the banner
          and buzz; the Alerts tab and its red dot keep working either way.
        </p>
        <IconItem icon={BellIcon} color={ac} title="Style, sound and length">
          The style is the vibration pattern, the sound is the tone, and the length is how long
          an alert keeps buzzing. Preview plays them here; Test closed sends a real notification
          a few seconds out, which is the only way to hear what arrives while the app is closed.
        </IconItem>
        <IconItem icon={BellIcon} color={ac} title="Your own sound file">
          Plays instead of the tone while the app is open. Once it is closed, Android can only
          play the bundled tone you picked.
        </IconItem>
      </div>

      <div className="flex flex-col gap-3">
        <SectionTitle>Controls</SectionTitle>
        <IconItem icon={PulseIcon} color={ac} title="Animation (pulse icon)">
          Pause or resume the waveform animation.
        </IconItem>
        <IconItem icon={PaletteIcon} color={fg} title="Appearance (palette icon)">
          Change the primary color, background and accent, or pick a preset.
        </IconItem>
        <IconItem icon={SunIcon} color={fg} title="Theme (sun / moon icon)">
          Switch between light and dark theme.
        </IconItem>
      </div>
    </>
  );
}

/** What each number means, and where it comes from. */
function ReadingsTab({ colors }: { colors: Colors }) {
  const { ac, fg, muted, amber, danger } = colors;

  return (
    <>
      <p className="text-muted-foreground text-sm leading-5">
        Readings come from an ESP32 on the transformer: a PZEM-004T energy meter for the electrical
        values and a DS18B20 contact probe on the transformer body for temperature. Until the board
        is wired in, the server simulates them, and they drift slightly over time like a real
        instrument.
      </p>

      <div className="flex flex-col gap-3">
        <SectionTitle>Readings</SectionTitle>

        <IconItem icon={LightningIcon} color={ac} title="Voltage" unit="unitV" unitColor={fg}>
          Root-mean-square line voltage. Nominal 230 V.
        </IconItem>
        <div className="flex flex-col gap-1.5 pl-11">
          <h4 className="font-semibold">RMS (root mean square)</h4>
          <p className="text-muted-foreground text-sm leading-5">
            The effective value of an AC signal: the equivalent steady (DC) value that delivers the
            same power.
          </p>
          <Formula name="rms" color={fg} mutedColor={muted} />
          <p className="text-muted-foreground text-sm leading-5">
            So 230 V RMS peaks at about 325 V.
          </p>
        </div>

        <IconItem icon={PlugsConnectedIcon} color={ac} title="Current" unit="unitA" unitColor={fg}>
          Current the load draws.
        </IconItem>

        <IconItem icon={GaugeIcon} color={ac} title="Apparent power" unit="unitVA" unitColor={fg}>
          Voltage times current. This is the number both thresholds judge, because a 1 KVA
          transformer is rated in VA, not watts.
        </IconItem>
        <div className="flex flex-col gap-1.5 pl-11">
          <Formula name="apparent" color={fg} mutedColor={muted} />
        </div>

        <IconItem icon={GaugeIcon} color={ac} title="Real power" unit="unitW" unitColor={fg}>
          What the load actually consumes, measured by the meter rather than derived.
        </IconItem>
        <div className="flex flex-col gap-1.5 pl-11">
          <Formula name="power" color={fg} mutedColor={muted} />
        </div>

        <IconItem icon={GaugeIcon} color={ac} title="Power factor">
          How much of the apparent power is doing real work, from 0 to 1. A value of 1 means
          the voltage and current waves are in step and every VA is useful. Motors and
          transformers pull it below 1, which is why a load can sit near the VA threshold
          while drawing fewer watts.
        </IconItem>
        <div className="flex flex-col gap-1.5 pl-11">
          <Formula name="powerFactor" color={fg} mutedColor={muted} />
        </div>

        <IconItem icon={GaugeIcon} color={ac} title="Reactive power" unit="unitVar" unitColor={fg}>
          The part that shuttles back and forth without doing work, sustaining the magnetic
          fields in motors and windings. It completes the power triangle, so it is derived
          rather than measured, and is shown only when real power was measured: it cannot be
          recovered from apparent power alone.
        </IconItem>
        <div className="flex flex-col gap-1.5 pl-11">
          <Formula name="reactive" color={fg} mutedColor={muted} />
        </div>

        <IconItem icon={WaveSineIcon} color={ac} title="Frequency" unit="unitHz" unitColor={fg}>
          AC cycles per second. Nominal 60 Hz on the Philippine grid.
        </IconItem>

        <IconItem icon={LightningIcon} color={ac} title="Energy" unit="unitKWh" unitColor={fg}>
          Cumulative energy the meter has counted since it was last reset. Unlike every other
          reading this one only climbs, so it measures consumption over time rather than the
          state right now.
        </IconItem>
        <div className="flex flex-col gap-1.5 pl-11">
          <Formula name="energy" color={fg} mutedColor={muted} />
        </div>

        <IconItem icon={GaugeIcon} color={ac} title="Headroom" unit="unitVA" unitColor={fg}>
          How much apparent power is left before the alarm threshold. It goes negative once
          the load is over, which is the same moment the reading is marked as an overload.
        </IconItem>
        <div className="flex flex-col gap-1.5 pl-11">
          <Formula name="headroom" color={fg} mutedColor={muted} />
        </div>

        <IconItem icon={ThermometerIcon} color={danger} title="Temperature" unit="unitC" unitColor={fg}>
          Transformer temperature, from the contact probe on the body. Its own threshold
          raises a separate alert from load. It does not trip the relay: the threshold is an
          advisory level for a transformer rather than a damage limit.
        </IconItem>
        <div className="flex flex-col gap-1.5 pl-11">
          <Formula name="fahrenheit" color={fg} mutedColor={muted} />
        </div>
      </div>

      <div className="flex flex-col gap-3">
        <SectionTitle>Waveform</SectionTitle>
        <div className="flex items-center gap-2">
          <span className="size-2.5 rounded-full" style={{ backgroundColor: ac }} aria-hidden="true" />
          <span className="text-sm">Voltage</span>
          <span className="ml-3 size-2.5 rounded-full" style={{ backgroundColor: amber }} aria-hidden="true" />
          <span className="text-sm">Current</span>
        </div>
        <p className="text-muted-foreground text-sm leading-5">
          Each sine wave alternates above and below the center (zero) line. That back-and-forth is
          what "alternating current" means. The current wave lags the voltage wave because of the
          load's power factor. The waveform is an illustration of the live values, not a sampled
          trace of the actual wave.
        </p>
      </div>
    </>
  );
}

export function InfoModal({ visible, onClose }: { visible: boolean; onClose: () => void }) {
  const { colorScheme } = useColorScheme();
  const isDark = colorScheme === 'dark';
  const { primary } = useAppearance();
  const { user } = useAuth();

  const [tab, setTab] = useState<Tab>('usage');
  // The readings tab holds a dozen typeset formulas, the most expensive thing in the
  // sheet to mount. Once shown, it is kept mounted and only hidden, so switching back
  // and forth does not remount them; it is not mounted at all until first opened, so a viewer who never leaves
  // the usage tab pays nothing.
  const [readingsMounted, setReadingsMounted] = useState(false);

  const colors: Colors = {
    ac: primary.hex,
    fg: isDark ? '#fafafa' : '#0a0a0a',
    muted: isDark ? '#a1a1aa' : '#71717a',
    amber: isDark ? '#fbbf24' : '#f59e0b',
    danger: isDark ? '#f87171' : '#dc2626',
  };

  function changeTab(next: Tab) {
    if (next === 'readings') setReadingsMounted(true);
    setTab(next);
  }

  return (
    <BottomSheet visible={visible} title="How it works" onClose={onClose}>
      <Segmented
        aria-label="Topic"
        className="self-center"
        options={TABS}
        value={tab}
        onValueChange={changeTab}
      />

      <div className={cn('flex flex-col gap-5', tab !== 'usage' && 'hidden')}>
        <UsageTab isAdmin={user?.role === 'admin'} colors={colors} />
      </div>

      {readingsMounted ? (
        <div className={cn('flex flex-col gap-5', tab !== 'readings' && 'hidden')}>
          <ReadingsTab colors={colors} />
        </div>
      ) : null}
    </BottomSheet>
  );
}
