import 'katex/dist/katex.min.css';

import katex from 'katex';
import { useMemo } from 'react';

import { cn } from '@/lib/utils';

// Formula blocks: the equation and its "where" list. Symbols are typeset with KaTeX;
// the descriptions stay as plain text in the app's own font.
const BLOCKS = {
  rms: {
    equation: String.raw`V_{\text{rms}} = \dfrac{V_{\text{peak}}}{\sqrt{2}}`,
    where: [
      { sym: String.raw`V_{\text{rms}}`, desc: 'effective RMS voltage' },
      { sym: String.raw`V_{\text{peak}}`, desc: 'peak voltage' },
    ],
  },
  power: {
    equation: String.raw`P = V \cdot I \cdot \cos\varphi`,
    where: [
      { sym: 'P', desc: 'real power (W)' },
      { sym: 'V', desc: 'RMS voltage (V)' },
      { sym: 'I', desc: 'RMS current (A)' },
      { sym: String.raw`\cos\varphi`, desc: 'power factor' },
    ],
  },
  apparent: {
    equation: String.raw`S = V \cdot I`,
    where: [
      { sym: 'S', desc: 'apparent power (VA), what the thresholds judge' },
      { sym: 'V', desc: 'RMS voltage (V)' },
      { sym: 'I', desc: 'RMS current (A)' },
    ],
  },
  powerFactor: {
    equation: String.raw`\mathrm{PF} = \dfrac{P}{S} = \cos\varphi`,
    where: [
      { sym: String.raw`\mathrm{PF}`, desc: 'power factor, 0 to 1' },
      { sym: 'P', desc: 'real power (W), what the load consumes' },
      { sym: 'S', desc: 'apparent power (VA), what it draws' },
      { sym: String.raw`\varphi`, desc: 'phase angle between voltage and current' },
    ],
  },
  reactive: {
    equation: String.raw`Q = \sqrt{S^{2} - P^{2}}`,
    where: [
      { sym: 'Q', desc: 'reactive power (var)' },
      { sym: 'S', desc: 'apparent power (VA)' },
      { sym: 'P', desc: 'real power (W)' },
    ],
  },
  headroom: {
    equation: String.raw`H = S_{\text{alarm}} - S`,
    where: [
      { sym: 'H', desc: 'headroom (VA), negative once over' },
      { sym: String.raw`S_{\text{alarm}}`, desc: 'alarm threshold (VA)' },
      { sym: 'S', desc: 'apparent power now (VA)' },
    ],
  },
  energy: {
    equation: String.raw`E = \int P \, dt`,
    where: [
      { sym: 'E', desc: 'energy (kWh), counted by the meter' },
      { sym: 'P', desc: 'real power (W)' },
      { sym: 't', desc: 'time' },
    ],
  },
  fahrenheit: {
    equation: String.raw`{}^{\circ}\mathrm{F} = {}^{\circ}\mathrm{C} \cdot \tfrac{9}{5} + 32`,
    where: [
      { sym: String.raw`{}^{\circ}\mathrm{C}`, desc: 'measured by the probe' },
      { sym: String.raw`{}^{\circ}\mathrm{F}`, desc: 'derived on the server, never stored' },
    ],
  },
};

// Standalone unit labels shown next to reading titles.
const UNITS = {
  unitV: String.raw`(\mathrm{V})`,
  unitA: String.raw`(\mathrm{A})`,
  unitW: String.raw`(\mathrm{W\,/\,kW})`,
  unitHz: String.raw`(\mathrm{Hz})`,
  unitVA: String.raw`(\mathrm{VA})`,
  unitVar: String.raw`(\mathrm{var})`,
  unitKWh: String.raw`(\mathrm{kWh})`,
  unitC: String.raw`({}^{\circ}\mathrm{C})`,
};

type BlockName = keyof typeof BLOCKS;
export type FormulaName = BlockName | keyof typeof UNITS;

function tex(latex: string) {
  return katex.renderToString(latex, { throwOnError: false, displayMode: false });
}

type FormulaProps = {
  name: FormulaName;
  color: string;
  mutedColor?: string;
  fontSize?: number;
  width?: number;
};

/** A typeset formula with its "where" list, or a unit label. */
export function Formula({ name, color, mutedColor, fontSize = 17, width }: FormulaProps) {
  const muted = mutedColor ?? color;

  const content = useMemo(() => {
    if (name in UNITS) {
      return { unit: tex(UNITS[name as keyof typeof UNITS]) };
    }

    const block = BLOCKS[name as BlockName];
    return {
      equation: tex(block.equation),
      where: block.where.map((w) => ({ sym: tex(w.sym), desc: w.desc })),
    };
  }, [name]);

  return (
    <div
      aria-hidden
      className={cn('pointer-events-none text-left leading-tight', !width && 'w-full')}
      style={{ width, color, fontSize }}>
      {'unit' in content ? (
        <span dangerouslySetInnerHTML={{ __html: content.unit ?? '' }} />
      ) : (
        <>
          <div className="mb-2 mt-0.5" dangerouslySetInnerHTML={{ __html: content.equation ?? '' }} />
          <p className="mb-1 text-[0.9em]" style={{ color: muted }}>
            where:
          </p>
          <dl className="flex flex-col gap-[3px]">
            {content.where?.map((w) => (
              <div key={w.desc} className="flex items-baseline gap-[7px]">
                <dt dangerouslySetInnerHTML={{ __html: w.sym }} />
                <dd className="text-[0.92em]" style={{ color: muted }}>
                  {w.desc}
                </dd>
              </div>
            ))}
          </dl>
        </>
      )}
    </div>
  );
}

/** Any one-line equation, in the surrounding text's colour and size. */
export function Tex({ latex }: { latex: string }) {
  const html = useMemo(() => tex(latex), [latex]);
  return <span aria-hidden dangerouslySetInnerHTML={{ __html: html }} />;
}
