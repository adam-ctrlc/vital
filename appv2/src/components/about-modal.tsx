import { BellIcon, LightningIcon, SignInIcon, UsersIcon, type Icon } from '@phosphor-icons/react';

import { BottomSheet } from '@/components/bottom-sheet';
import { useAppearance, useColorScheme } from '@/lib/appearance';

function Section({
  icon: SectionIcon,
  title,
  color,
  children,
}: {
  icon: Icon;
  title: string;
  color: string;
  children: string;
}) {
  return (
    <section className="flex gap-3">
      <span
        className="grid size-8 shrink-0 place-items-center rounded-full"
        style={{ backgroundColor: `${color}1f` }}>
        <SectionIcon size={16} weight="bold" color={color} aria-hidden="true" />
      </span>
      <div className="flex-1 space-y-1">
        <h3 className="font-semibold">{title}</h3>
        <p className="text-muted-foreground text-sm leading-5">{children}</p>
      </div>
    </section>
  );
}

/**
 * The plain-language introduction shown before sign-in. The technical guide,
 * with the formulas, lives in InfoModal on the dashboard.
 */
export function AboutModal({ visible, onClose }: { visible: boolean; onClose: () => void }) {
  const { primary } = useAppearance();
  const { colorScheme } = useColorScheme();
  const ac = primary.hex;
  const danger = colorScheme === 'dark' ? '#f87171' : '#dc2626';

  return (
    <BottomSheet visible={visible} title="About VITAL" onClose={onClose}>
      <Section icon={LightningIcon} title="What this app is for" color={ac}>
        It watches a 1 KVA distribution transformer and shows its voltage, current, temperature
        and load as they happen, so problems are noticed before something fails.
      </Section>

      <Section icon={BellIcon} title="Why it matters" color={danger}>
        An overloaded or overheating transformer can fail without warning. VITAL raises an
        alert the moment load reaches 900 VA or temperature reaches 40 °C, and records who
        responded and how quickly.
      </Section>

      <Section icon={UsersIcon} title="Who uses it" color={ac}>
        Maintenance engineers get everything, including thresholds, logs and accounts. Power
        utility personnel get live monitoring and alerts.
      </Section>

      <Section icon={SignInIcon} title="How to sign in" color={ac}>
        Ask the admin to create an account for you.
      </Section>

      {/* The footer is provenance, not another section, so it sits below a rule. The
          seal anchors it and the address breaks on its natural lines. */}
      <footer className="flex flex-col gap-3 border-t pt-4">
        <div className="flex items-center gap-3">
          <img
            src="/images/phinmacoc.png"
            width={40}
            height={40}
            className="size-10 object-contain"
            alt="PHINMA Cagayan de Oro College"
          />
          <address className="flex-1 space-y-0.5 not-italic">
            <p className="text-xs font-semibold leading-4">PHINMA Cagayan de Oro College</p>
            <p className="text-muted-foreground text-[10px] leading-[13px]">Carmen Campus, Max Suniel Street</p>
            <p className="text-muted-foreground text-[10px] leading-[13px]">
              Cagayan de Oro City, 9000, Misamis Oriental
            </p>
          </address>
        </div>

        <p className="text-muted-foreground text-center text-[9px] uppercase tracking-widest">
          Electrical Engineering Thesis Project
        </p>
      </footer>
    </BottomSheet>
  );
}
