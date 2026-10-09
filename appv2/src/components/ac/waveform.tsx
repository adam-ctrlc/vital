import { useEffect, useRef, useState } from 'react';

/** Nominal supply, for scaling the voltage wave. */
const NOMINAL_V = 230;
/** How quickly the drawn wave catches up with a new reading: about 63% per this many ms. */
const EASE_MS = 350;
/** One cycle across this many milliseconds on screen. Slowed far below 60 Hz to be visible. */
const PERIOD_MS = 470;
/** Whole cycles across the width. */
const PERIODS = 3;
/** Points per path. Enough for a smooth curve at phone and desktop widths. */
const STEPS = 160;

/** Where the current wave tops out at exactly the alarm threshold, as a share of half-height. */
const LIMIT_AMP = 0.72;
/** The current wave never shrinks below this, so a light load still reads as a wave. */
const MIN_CURRENT_AMP = 0.08;

type AcWaveformProps = {
  /** False before the first reading: both waves ease down to a flat line. */
  energized: boolean;
  /** Paused stops the travel; the wave still follows the readings. */
  animated?: boolean;
  voltageV?: number | null;
  /** Apparent power over the alarm threshold. 1 is exactly at the alarm. */
  loadRatio?: number | null;
  powerFactor?: number | null;
  overload?: boolean;
  voltageColor: string;
  currentColor: string;
  dangerColor: string;
  gridColor?: string;
};

type Shape = { vAmp: number; iAmp: number; lag: number; load: number };

function clamp(value: number, min: number, max: number) {
  return Math.min(max, Math.max(min, value));
}

/** What the readings ask the wave to look like. */
function targetShape(props: AcWaveformProps): Shape {
  if (!props.energized) return { vAmp: 0.02, iAmp: 0.02, lag: 0, load: 0 };

  const load = clamp(props.loadRatio ?? 0, 0, 1.4);
  const volts = props.voltageV ?? NOMINAL_V;

  return {
    vAmp: clamp(0.82 * (volts / NOMINAL_V), 0.5, 0.92),
    // Linear in load, so twice the load is twice the height, reaching the dashed limit
    // lines exactly at the alarm threshold and passing them in overload.
    iAmp: clamp(MIN_CURRENT_AMP + (LIMIT_AMP - MIN_CURRENT_AMP) * load, MIN_CURRENT_AMP, 0.95),
    // Current lags voltage by the power-factor angle, as with an inductive load.
    lag: Math.acos(clamp(props.powerFactor ?? 0.95, 0, 1)),
    load,
  };
}

function sinePath(width: number, mid: number, amp: number, phase: number) {
  let d = '';
  for (let i = 0; i <= STEPS; i++) {
    const x = (width * i) / STEPS;
    const y = mid - amp * Math.sin((2 * Math.PI * PERIODS * i) / STEPS + phase);
    d += `${i === 0 ? 'M' : 'L'}${x.toFixed(1)} ${y.toFixed(1)} `;
  }
  return d;
}

/** Blends two #rrggbb colours. */
function mix(a: string, b: string, t: number) {
  const parse = (hex: string) => [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16));
  const [ar, ag, ab] = parse(a);
  const [br, bg, bb] = parse(b);
  const channel = (x: number, y: number) => Math.round(x + (y - x) * t).toString(16).padStart(2, '0');
  return `#${channel(ar, br)}${channel(ag, bg)}${channel(ab, bb)}`;
}

/**
 * The voltage and current waves, drawn from the live reading.
 *
 * The current wave is the load: its height is proportional to apparent power, reaching
 * the dashed limit lines at the alarm threshold, and it thickens, glows and warms toward
 * red as it gets there. In overload the glow pulses. The gap between the waves is the power-factor angle. Every change
 * is eased, so a load coming on is seen to swell rather than jump.
 *
 * Drawn on each animation frame by setting the paths directly, not through React state,
 * so sixty frames a second costs no re-renders.
 */
export function AcWaveform(props: AcWaveformProps) {
  const { animated = true, gridColor = 'rgba(148, 163, 184, 0.25)' } = props;

  const box = useRef<HTMLDivElement>(null);
  const [size, setSize] = useState({ width: 0, height: 0 });

  const voltageGlow = useRef<SVGPathElement>(null);
  const voltageLine = useRef<SVGPathElement>(null);
  const currentGlow = useRef<SVGPathElement>(null);
  const currentLine = useRef<SVGPathElement>(null);

  // The latest props for the frame loop, without restarting it on every reading.
  const latest = useRef(props);
  latest.current = props;
  const playing = useRef(animated);
  playing.current = animated;

  useEffect(() => {
    const element = box.current;
    if (!element) return;

    const observer = new ResizeObserver(([entry]) => {
      const { width, height } = entry.contentRect;
      setSize((prev) => (prev.width === width && prev.height === height ? prev : { width, height }));
    });
    observer.observe(element);
    return () => observer.disconnect();
  }, []);

  useEffect(() => {
    const { width, height } = size;
    if (width <= 0 || height <= 0) return;

    const mid = height / 2;
    const half = height / 2;
    // Starts flat and grows into the first reading.
    const shape: Shape = { vAmp: 0.02, iAmp: 0.02, lag: 0, load: 0 };
    let phase = 0;
    let last = performance.now();
    let frame = 0;

    const draw = (now: number) => {
      const dt = Math.min(now - last, 100);
      last = now;

      const target = targetShape(latest.current);
      const k = 1 - Math.exp(-dt / EASE_MS);
      shape.vAmp += (target.vAmp - shape.vAmp) * k;
      shape.iAmp += (target.iAmp - shape.iAmp) * k;
      shape.lag += (target.lag - shape.lag) * k;
      shape.load += (target.load - shape.load) * k;

      // Runs regardless of reduced motion, because the motion is the reading; the pause
      // button is the way to stop it.
      if (playing.current) phase += (2 * Math.PI * dt) / PERIOD_MS;

      const { voltageColor, currentColor, dangerColor, overload } = latest.current;
      // Warms from the current colour to the danger colour over the last 15% to the alarm.
      const heat = overload ? 1 : clamp((shape.load - 0.85) / 0.15, 0, 1);
      const iColor = mix(currentColor, dangerColor, heat);
      // In overload the glow breathes, about once a second.
      const pulse = overload ? 0.5 + 0.5 * Math.sin(now / 160) : 0;

      const vPath = sinePath(width, mid, half * shape.vAmp, phase);
      const iPath = sinePath(width, mid, half * shape.iAmp, phase - shape.lag);

      voltageGlow.current?.setAttribute('d', vPath);
      voltageLine.current?.setAttribute('d', vPath);
      currentGlow.current?.setAttribute('d', iPath);
      currentLine.current?.setAttribute('d', iPath);

      voltageGlow.current?.setAttribute('stroke', voltageColor);
      voltageLine.current?.setAttribute('stroke', voltageColor);
      for (const path of [currentGlow.current, currentLine.current]) path?.setAttribute('stroke', iColor);

      // Heavier load, heavier line.
      currentLine.current?.setAttribute('stroke-width', (2 + 2.5 * Math.min(shape.load, 1.2)).toFixed(2));
      currentGlow.current?.setAttribute('stroke-width', (6 + 12 * Math.min(shape.load, 1.2) + 6 * pulse).toFixed(2));
      currentGlow.current?.setAttribute('stroke-opacity', (0.1 + 0.2 * Math.min(shape.load, 1) + 0.2 * pulse).toFixed(3));

      frame = requestAnimationFrame(draw);
    };

    frame = requestAnimationFrame(draw);
    return () => cancelAnimationFrame(frame);
  }, [size]);

  const { width, height } = size;
  // The legend follows the wave's colour, from the reading rather than the eased value.
  const legendCurrent = props.overload
    ? props.dangerColor
    : mix(props.currentColor, props.dangerColor, clamp(((props.loadRatio ?? 0) - 0.85) / 0.15, 0, 1));
  const limitTop = height / 2 - (height / 2) * LIMIT_AMP;
  const limitBottom = height / 2 + (height / 2) * LIMIT_AMP;

  return (
    <div ref={box} className="relative h-full w-full overflow-hidden">
      {width > 0 && height > 0 ? (
        <svg width={width} height={height} className="absolute inset-0" aria-hidden="true">
          <line x1={0} y1={height / 2} x2={width} y2={height / 2} stroke={gridColor} strokeWidth={1.5} />
          {/* Where the current peaks at exactly the alarm threshold. */}
          <line x1={0} y1={limitTop} x2={width} y2={limitTop} stroke={props.dangerColor} strokeOpacity={0.35} strokeWidth={1} strokeDasharray="4 4" />
          <line x1={0} y1={limitBottom} x2={width} y2={limitBottom} stroke={props.dangerColor} strokeOpacity={0.35} strokeWidth={1} strokeDasharray="4 4" />
          <text x={2} y={limitTop - 4} fill={props.dangerColor} fillOpacity={0.7} fontSize={9} fontWeight={600}>
            LIMIT
          </text>

          <path ref={currentGlow} fill="none" strokeLinecap="round" strokeLinejoin="round" />
          <path ref={voltageGlow} fill="none" strokeOpacity={0.16} strokeWidth={9} strokeLinecap="round" strokeLinejoin="round" />
          <path ref={voltageLine} fill="none" strokeWidth={2.5} strokeLinecap="round" strokeLinejoin="round" />
          <path ref={currentLine} fill="none" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
      ) : null}

      <div className="text-muted-foreground absolute bottom-1 left-0 flex gap-3 text-[10px] font-medium">
        <span className="flex items-center gap-1">
          <span className="h-0.5 w-3 rounded-full" style={{ backgroundColor: props.voltageColor }} />
          Voltage
        </span>
        <span className="flex items-center gap-1">
          <span className="h-0.5 w-3 rounded-full" style={{ backgroundColor: legendCurrent }} />
          Current
        </span>
      </div>
    </div>
  );
}
