import { useColorScheme } from 'nativewind';
import type { IconProps } from 'phosphor-react-native';
import Bell from 'phosphor-react-native/src/icons/Bell';
import ChartLine from 'phosphor-react-native/src/icons/ChartLine';
import Gauge from 'phosphor-react-native/src/icons/Gauge';
import Gear from 'phosphor-react-native/src/icons/Gear';
import Lightning from 'phosphor-react-native/src/icons/Lightning';
import Palette from 'phosphor-react-native/src/icons/Palette';
import PlugsConnected from 'phosphor-react-native/src/icons/PlugsConnected';
import Pulse from 'phosphor-react-native/src/icons/Pulse';
import Sun from 'phosphor-react-native/src/icons/Sun';
import Thermometer from 'phosphor-react-native/src/icons/Thermometer';
import UserCircle from 'phosphor-react-native/src/icons/UserCircle';
import WaveSine from 'phosphor-react-native/src/icons/WaveSine';
import Warning from 'phosphor-react-native/src/icons/Warning';
import { useState, type ComponentType } from 'react';
import { View } from 'react-native';

import { BottomSheet } from '@/components/bottom-sheet';
import { Formula } from '@/components/formula';
import { Segmented } from '@/components/ui/segmented';
import { Text } from '@/components/ui/text';
import { useAuth } from '@/features/auth/context';
import { useAppearance } from '@/lib/appearance';
import type { FormulaName } from '@/lib/katex-assets';

type Tab = 'usage' | 'readings';

const TABS = [
  { label: 'Using the app', value: 'usage' as Tab, icon: Gauge },
  { label: 'The readings', value: 'readings' as Tab, icon: WaveSine },
];

function IconItem({
  icon: Icon,
  color,
  title,
  unit,
  unitColor,
  children,
}: {
  icon: ComponentType<IconProps>;
  color: string;
  title: string;
  unit?: FormulaName;
  unitColor?: string;
  children: string;
}) {
  return (
    <View className="flex-row gap-3">
      <View className="bg-accent mt-0.5 h-8 w-8 items-center justify-center rounded-lg">
        <Icon size={18} weight="bold" color={color} />
      </View>
      <View className="flex-1 gap-0.5">
        <View className="flex-row items-center gap-1.5">
          <Text className="font-semibold">{title}</Text>
          {unit && unitColor ? (
            <Formula name={unit} color={unitColor} fontSize={15} width={84} />
          ) : null}
        </View>
        <Text variant="muted" className="text-sm leading-5">
          {children}
        </Text>
      </View>
    </View>
  );
}

function SectionTitle({ children }: { children: string }) {
  return (
    <Text variant="muted" className="text-xs uppercase tracking-wide">
      {children}
    </Text>
  );
}

type Colors = { ac: string; fg: string; muted: string; amber: string; danger: string };

/** What each screen is for. Only the screens the signed-in role can open are listed. */
function UsageTab({ isAdmin, colors }: { isAdmin: boolean; colors: Colors }) {
  const { ac, fg, amber, danger } = colors;

  return (
    <>
      <Text variant="muted" className="text-sm leading-5">
        {isAdmin
          ? 'You are signed in as a maintenance engineer, so every screen is open to you.'
          : 'You are signed in as power utility personnel: monitoring and alerts. Logs and settings are for maintenance engineers.'}
      </Text>

      <View className="gap-3">
        <SectionTitle>Screens</SectionTitle>

        <IconItem icon={Gauge} color={ac} title="Monitor">
          The live view. The big number is apparent power in VA, judged against the load
          threshold. Below it are current, voltage and temperature, then the metering
          panel.
        </IconItem>

        <IconItem icon={Bell} color={danger} title="Alerts">
          Opens on active alerts only. Acknowledge one to record who responded and how long it
          took. Switch to All to see acknowledged ones, and filter by kind or search the message.
        </IconItem>

        {isAdmin ? (
          <IconItem icon={ChartLine} color={ac} title="Logs">
            Every stored reading, newest first. Search by status, source, power or date, filter to
            overloads, and page through. The bar chart shows the daily average load, with the dashed
            line marking that day's peak.
          </IconItem>
        ) : null}

        {isAdmin ? (
          <IconItem icon={Gear} color={ac} title="Settings">
            Set the alarm, trip and temperature thresholds every reading is judged against, switch
            between the simulation and the board, and manage the ESP32: its link state and live
            telemetry.
          </IconItem>
        ) : null}

        <IconItem icon={UserCircle} color={ac} title="Profile">
          Edit your name, change your password, and sign out. Your email and access level are set by
          an admin.
        </IconItem>
      </View>

      <View className="gap-3">
        <SectionTitle>Alerts</SectionTitle>
        <IconItem icon={Warning} color={danger} title="When one is raised">
          Automatically, the moment a reading reaches a threshold. A red dot appears on the Alerts
          tab while any alert is still unacknowledged.
        </IconItem>
        <Text variant="muted" className="text-sm leading-5">
          {isAdmin
            ? 'A repeat of the same kind does not stack: while one is unacknowledged, no duplicate is raised. The Logs tab also shows a red dot when new overloads are recorded.'
            : 'A repeat of the same kind does not stack: while one is unacknowledged, no duplicate is raised.'}
        </Text>
      </View>

      <View className="gap-3">
        <SectionTitle>Protection</SectionTitle>
        <Text variant="muted" className="text-sm leading-5">
          There are two load levels, and they do different things. The alarm only tells you: it
          raises an alert and marks the reading as an overload, but the transformer keeps
          supplying. The trip sits above it and is what actually cuts the load, so somebody has
          a window to shed load themselves before the board does it for them.
        </Text>
        <IconItem icon={PlugsConnected} color={amber} title="When the load is cut">
          The load has to stay above the trip level for three seconds first, so a motor starting
          up cannot cut the supply. The board then opens the relay and holds it open for at
          least thirty seconds.
        </IconItem>
        <IconItem icon={PlugsConnected} color={ac} title="When it comes back">
          Once the load is back under the alarm level and the thirty seconds have passed. It
          will not restore while the load is merely off the trip point, and it will not restore
          at all while the energy meter is unreadable, because the board cannot confirm the
          fault is gone.
        </IconItem>
        <Text variant="muted" className="text-sm leading-5">
          This runs on the board itself, not here, so it still protects the transformer when the
          Wi-Fi is down or the app is closed. A trip survives a reboot as well.
        </Text>
      </View>

      <View className="gap-3">
        <SectionTitle>Controls</SectionTitle>
        <IconItem icon={Pulse} color={ac} title="Animation (pulse icon)">
          Pause or resume the waveform animation.
        </IconItem>
        <IconItem icon={Palette} color={fg} title="Appearance (palette icon)">
          Change the AC color, background and accent, or pick a preset.
        </IconItem>
        <IconItem icon={Sun} color={fg} title="Theme (sun / moon icon)">
          Switch between light and dark theme.
        </IconItem>
      </View>
    </>
  );
}

/** What each number means, and where it comes from. */
function ReadingsTab({ colors }: { colors: Colors }) {
  const { ac, fg, muted, amber, danger } = colors;

  return (
    <>
      <Text variant="muted" className="text-sm leading-5">
        Readings come from an ESP32 on the transformer: a PZEM-004T energy meter for the electrical
        values and a DS18B20 contact probe on the transformer body for temperature. Until the board
        is wired in, the server simulates them, and they drift slightly over time like a real
        instrument.
      </Text>

      <View className="gap-3">
        <SectionTitle>Readings</SectionTitle>

        <IconItem icon={Lightning} color={ac} title="Voltage" unit="unitV" unitColor={fg}>
          Root-mean-square line voltage. Nominal 230 V.
        </IconItem>
        <View className="gap-1.5 pl-11">
          <Text className="font-semibold">RMS (root mean square)</Text>
          <Text variant="muted" className="text-sm leading-5">
            The effective value of an AC signal: the equivalent steady (DC) value that delivers the
            same power.
          </Text>
          <Formula name="rms" color={fg} mutedColor={muted} />
          <Text variant="muted" className="text-sm leading-5">
            So 230 V RMS peaks at about 325 V.
          </Text>
        </View>

        <IconItem icon={PlugsConnected} color={ac} title="Current" unit="unitA" unitColor={fg}>
          Current the load draws.
        </IconItem>

        <IconItem icon={Gauge} color={ac} title="Apparent power" unit="unitVA" unitColor={fg}>
          Voltage times current. This is the number both thresholds judge, because a 1 KVA
          transformer is rated in VA, not watts.
        </IconItem>
        <View className="gap-1.5 pl-11">
          <Formula name="apparent" color={fg} mutedColor={muted} />
        </View>

        <IconItem icon={Gauge} color={ac} title="Real power" unit="unitW" unitColor={fg}>
          What the load actually consumes, measured by the meter rather than derived.
        </IconItem>
        <View className="gap-1.5 pl-11">
          <Formula name="power" color={fg} mutedColor={muted} />
        </View>

        <IconItem icon={Gauge} color={ac} title="Power factor">
          How much of the apparent power is doing real work, from 0 to 1. A value of 1 means
          the voltage and current waves are in step and every VA is useful. Motors and
          transformers pull it below 1, which is why a load can sit near the VA threshold
          while drawing fewer watts.
        </IconItem>
        <View className="gap-1.5 pl-11">
          <Formula name="powerFactor" color={fg} mutedColor={muted} />
        </View>

        <IconItem icon={Gauge} color={ac} title="Reactive power" unit="unitVar" unitColor={fg}>
          The part that shuttles back and forth without doing work, sustaining the magnetic
          fields in motors and windings. It completes the power triangle, so it is derived
          rather than measured, and is shown only when real power was measured: it cannot be
          recovered from apparent power alone.
        </IconItem>
        <View className="gap-1.5 pl-11">
          <Formula name="reactive" color={fg} mutedColor={muted} />
        </View>

        <IconItem icon={WaveSine} color={ac} title="Frequency" unit="unitHz" unitColor={fg}>
          AC cycles per second. Nominal 60 Hz on the Philippine grid.
        </IconItem>

        <IconItem icon={Lightning} color={ac} title="Energy" unit="unitKWh" unitColor={fg}>
          Cumulative energy the meter has counted since it was last reset. Unlike every other
          reading this one only climbs, so it measures consumption over time rather than the
          state right now.
        </IconItem>
        <View className="gap-1.5 pl-11">
          <Formula name="energy" color={fg} mutedColor={muted} />
        </View>

        <IconItem icon={Gauge} color={ac} title="Headroom" unit="unitVA" unitColor={fg}>
          How much apparent power is left before the alarm threshold. It goes negative once
          the load is over, which is the same moment the reading is marked as an overload.
        </IconItem>
        <View className="gap-1.5 pl-11">
          <Formula name="headroom" color={fg} mutedColor={muted} />
        </View>

        <IconItem icon={Thermometer} color={danger} title="Temperature" unit="unitC" unitColor={fg}>
          Transformer temperature, from the contact probe on the body. Its own threshold
          raises a separate alert from load. It does not trip the relay: the threshold is an
          advisory level for a transformer rather than a damage limit.
        </IconItem>
        <View className="gap-1.5 pl-11">
          <Formula name="fahrenheit" color={fg} mutedColor={muted} />
        </View>
      </View>

      <View className="gap-3">
        <SectionTitle>Waveform</SectionTitle>
        <View className="flex-row items-center gap-2">
          <View className="h-2.5 w-2.5 rounded-full" style={{ backgroundColor: ac }} />
          <Text className="text-sm">Voltage</Text>
          <View className="ml-3 h-2.5 w-2.5 rounded-full" style={{ backgroundColor: amber }} />
          <Text className="text-sm">Current</Text>
        </View>
        <Text variant="muted" className="text-sm leading-5">
          Each sine wave alternates above and below the center (zero) line. That back-and-forth is
          what "alternating current" means. The current wave lags the voltage wave because of the
          load's power factor. The waveform is an illustration of the live values, not a sampled
          trace of the actual wave.
        </Text>
      </View>
    </>
  );
}

export function InfoModal({ visible, onClose }: { visible: boolean; onClose: () => void }) {
  const { colorScheme } = useColorScheme();
  const isDark = colorScheme === 'dark';
  const { primary } = useAppearance();
  const { user } = useAuth();

  const [tab, setTab] = useState<Tab>('usage');
  // The readings tab holds KaTeX WebViews, which are expensive to mount. Once shown,
  // it is kept mounted and only hidden, so switching back and forth does not remount
  // them; it is not mounted at all until first opened, so a viewer who never leaves
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
        className="self-center"
        options={TABS}
        value={tab}
        onChange={changeTab}
        activeColor={colors.ac}
        inactiveColor={colors.muted}
      />

      <View style={{ display: tab === 'usage' ? 'flex' : 'none' }} className="gap-5">
        <UsageTab isAdmin={user?.role === 'admin'} colors={colors} />
      </View>

      {readingsMounted ? (
        <View style={{ display: tab === 'readings' ? 'flex' : 'none' }} className="gap-5">
          <ReadingsTab colors={colors} />
        </View>
      ) : null}
    </BottomSheet>
  );
}
