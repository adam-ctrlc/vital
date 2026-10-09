import { useEffect, useMemo, useRef, useState } from 'react';

import { useColorScheme } from '@/lib/appearance';
import { dateLabel } from '@/lib/units';

const HEIGHT = 150;
const AXIS = 16;
const LABEL = 14;
const MAX_BAR = 44;

export type DayBar = { date: string; value: number | null; highlight?: boolean; tooltip: string };

/**
 * One bar per day, in the style of the Logs chart. With many days only the tallest bar is
 * labelled and the day labels thin out, so nothing collides.
 */
export function DayBars({
  bars,
  color,
  highlightColor,
  format,
  label,
}: {
  bars: DayBar[];
  color: string;
  highlightColor?: string;
  format: (value: number) => string;
  label: string;
}) {
  const box = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(0);
  const { colorScheme } = useColorScheme();
  const muted = colorScheme === 'dark' ? '#a1a1aa' : '#71717a';

  useEffect(() => {
    const node = box.current;
    if (!node) return;
    const observer = new ResizeObserver(([entry]) => setWidth(entry.contentRect.width));
    observer.observe(node);
    return () => observer.disconnect();
  }, []);

  const layout = useMemo(() => {
    if (width <= 0 || bars.length === 0) return [];
    const count = bars.length;
    const gap = count > 20 ? 2 : count > 10 ? 4 : 10;
    const barWidth = Math.min(MAX_BAR, (width - gap * (count - 1)) / count);
    const startX = (width - (barWidth * count + gap * (count - 1))) / 2;
    const ceiling = Math.max(...bars.map((b) => b.value ?? 0), 0.000001) * 1.2;
    const plot = HEIGHT - AXIS - LABEL;
    const peak = bars.reduce((best, bar, i) => ((bar.value ?? -1) > (bars[best].value ?? -1) ? i : best), 0);
    const labelEvery = Math.max(1, Math.ceil(count / Math.max(1, Math.floor(width / 44))));

    // Labels near either edge are pulled in so they are never cut off.
    const clampX = (x: number) => Math.min(width - 18, Math.max(18, x));

    return bars.map((bar, i) => {
      const height = bar.value === null || bar.value <= 0 ? 0 : Math.max((bar.value / ceiling) * plot, 2);
      return {
        bar,
        x: startX + i * (barWidth + gap),
        y: HEIGHT - AXIS - height,
        width: barWidth,
        height,
        labelX: clampX(startX + i * (barWidth + gap) + barWidth / 2),
        showValue: count <= 10 || i === peak,
        showDay: i % labelEvery === 0,
      };
    });
  }, [bars, width]);

  return (
    <div ref={box} style={{ height: HEIGHT }} className="w-full">
      {width > 0 ? (
        <svg width={width} height={HEIGHT} role="img" aria-label={label}>
          {layout.map((item) => (
            <g key={item.bar.date}>
              <title>{item.bar.tooltip}</title>
              {/* A full-height hit area, so a short bar is still easy to hover. */}
              <rect x={item.x} y={0} width={item.width} height={HEIGHT - AXIS} fill="transparent" />
              {item.height > 0 ? (
                <rect
                  x={item.x}
                  y={item.y}
                  width={item.width}
                  height={item.height}
                  rx={Math.min(4, item.width / 2)}
                  fill={item.bar.highlight && highlightColor ? highlightColor : color}
                />
              ) : null}
              {item.showValue && item.bar.value !== null ? (
                <text x={item.labelX} y={item.y - 5} fill={muted} fontSize={9} fontWeight="600" textAnchor="middle">
                  {format(item.bar.value)}
                </text>
              ) : null}
              {item.showDay ? (
                <text x={item.labelX} y={HEIGHT - 4} fill={muted} fontSize={9} textAnchor="middle">
                  {dateLabel(item.bar.date)}
                </text>
              ) : null}
            </g>
          ))}
          <line x1={0} y1={HEIGHT - AXIS} x2={width} y2={HEIGHT - AXIS} stroke="rgba(148, 163, 184, 0.25)" strokeWidth={1} />
        </svg>
      ) : null}
    </div>
  );
}
