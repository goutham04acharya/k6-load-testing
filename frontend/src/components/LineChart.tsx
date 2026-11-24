import { useLayoutEffect, useRef, useState } from 'react';
import { fmtClock } from '../lib/format';

export interface Point {
  x: number; // seconds since start
  y: number;
}

interface Props {
  points: Point[];
  format: (v: number) => string;
  height?: number;
  label: string; // for screen readers
  step?: boolean; // draw as steps (load-shape preview)
  xMax?: number;
  emptyText?: string;
}

/** One measure, one axis, 2px line, recessive grid, crosshair + tooltip on hover. */
export function LineChart({ points, format, height = 180, label, step = false, xMax, emptyText = 'Waiting for data…' }: Props) {
  const ref = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(600);
  const [hover, setHover] = useState<number | null>(null);

  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const ro = new ResizeObserver(([e]) => setWidth(Math.max(240, e.contentRect.width)));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  const pad = { l: 52, r: 12, t: 10, b: 24 };
  const w = width - pad.l - pad.r;
  const h = height - pad.t - pad.b;

  if (points.length < 2) {
    return (
      <div ref={ref} style={{ height, display: 'grid', placeItems: 'center' }} className="muted small">
        {emptyText}
      </div>
    );
  }

  const x0 = points[0].x;
  const x1 = Math.max(xMax ?? 0, points[points.length - 1].x, x0 + 1);
  const { max: yMax, ticks } = niceScale(Math.max(...points.map((p) => p.y), 0), points.every((p) => Number.isInteger(p.y)));
  const sx = (x: number) => pad.l + ((x - x0) / (x1 - x0)) * w;
  const sy = (y: number) => pad.t + h - (yMax ? (y / yMax) * h : 0);

  let d = '';
  points.forEach((p, i) => {
    if (i === 0) d += `M${sx(p.x)},${sy(p.y)}`;
    else if (step) d += `L${sx(p.x)},${sy(points[i - 1].y)}L${sx(p.x)},${sy(p.y)}`;
    else d += `L${sx(p.x)},${sy(p.y)}`;
  });
  const area = `${d}L${sx(points[points.length - 1].x)},${sy(0)}L${sx(x0)},${sy(0)}Z`;
  const xTicks = 4;

  const onMove = (e: React.PointerEvent<SVGRectElement>) => {
    const rect = (e.currentTarget as SVGRectElement).getBoundingClientRect();
    const x = x0 + ((e.clientX - rect.left) / rect.width) * (x1 - x0);
    let best = 0;
    points.forEach((p, i) => { if (Math.abs(p.x - x) < Math.abs(points[best].x - x)) best = i; });
    setHover(best);
  };
  const hp = hover != null ? points[hover] : null;

  return (
    <div ref={ref} style={{ position: 'relative' }}>
      <svg width={width} height={height} role="img" aria-label={`${label}: latest ${format(points[points.length - 1].y)}`}>
        {ticks.map((t) => (
          <g key={t}>
            <line x1={pad.l} x2={pad.l + w} y1={sy(t)} y2={sy(t)} stroke="var(--grid)" strokeWidth="1" />
            <text x={pad.l - 8} y={sy(t) + 4} textAnchor="end" fontSize="11" fill="var(--muted)">{format(t)}</text>
          </g>
        ))}
        {Array.from({ length: xTicks + 1 }, (_, i) => x0 + ((x1 - x0) * i) / xTicks).map((t, i) => (
          <text key={i} x={sx(t)} y={height - 6} textAnchor={i === 0 ? 'start' : i === xTicks ? 'end' : 'middle'} fontSize="11" fill="var(--muted)">
            {fmtClock(t)}
          </text>
        ))}
        <path d={area} fill="var(--series)" opacity="0.08" />
        <path d={d} fill="none" stroke="var(--series)" strokeWidth="2" strokeLinejoin="round" strokeLinecap="round" />
        {hp && (
          <g>
            <line x1={sx(hp.x)} x2={sx(hp.x)} y1={pad.t} y2={pad.t + h} stroke="var(--line-strong)" strokeWidth="1" />
            <circle cx={sx(hp.x)} cy={sy(hp.y)} r="4.5" fill="var(--series)" stroke="var(--surface)" strokeWidth="2" />
          </g>
        )}
        <rect x={pad.l} y={pad.t} width={w} height={h} fill="transparent" onPointerMove={onMove} onPointerLeave={() => setHover(null)} />
      </svg>
      {hp && (
        <div
          className="card"
          style={{
            position: 'absolute', pointerEvents: 'none', padding: '6px 10px', fontSize: 12,
            left: Math.min(sx(hp.x) + 10, width - 130), top: Math.max(0, sy(hp.y) - 44),
          }}
        >
          <div className="muted">{fmtClock(hp.x)}</div>
          <strong style={{ fontVariantNumeric: 'tabular-nums' }}>{format(hp.y)}</strong>
        </div>
      )}
    </div>
  );
}

/** Round axis: about 4 steps of 1, 2, 2.5 or 5 × 10^n, so tick labels are even numbers. */
function niceScale(v: number, integers = false): { max: number; ticks: number[] } {
  if (v <= 0) return integers ? { max: 1, ticks: [0, 1] } : { max: 1, ticks: [0, 0.25, 0.5, 0.75, 1] };
  const raw = v / 4;
  const mag = 10 ** Math.floor(Math.log10(raw));
  const n = raw / mag;
  let step = (n <= 1 ? 1 : n <= 2 ? 2 : n <= 2.5 ? 2.5 : n <= 5 ? 5 : 10) * mag;
  if (integers) step = Math.max(1, Math.round(step)); // whole-number series (users) get whole-number ticks
  const max = Math.ceil(v / step - 1e-9) * step;
  return { max, ticks: Array.from({ length: Math.round(max / step) + 1 }, (_, i) => +(i * step).toPrecision(12)) };
}
