import type { ReactNode } from 'react';
import { compact } from './format';
import { cx, SERIES } from './primitives';

/** Vertical bars with value + label, estimated bars hatched (design: booked revenue). */
export function BarChart({ data, height = 200, format = (v: number) => compact(v) }: { data: Array<{ label: string; value: number; estimated?: boolean }>; height?: number; format?: (v: number) => string }) {
  const max = Math.max(1, ...data.map((d) => d.value));
  const usable = height - 44;
  return (
    <div className="lc-bars" style={{ height }}>
      {data.map((d, i) => (
        <div key={i} className="lc-bar-col" title={`${d.label}: ${format(d.value)}${d.estimated ? ' (estimated)' : ''}`}>
          <span className="lc-bar-label">{format(d.value)}</span>
          <div className={cx('lc-bar', d.estimated && 'lc-bar--est')} style={{ height: Math.max(1, Math.round((d.value / max) * usable)) }} />
          <span className="lc-bar-label">{d.label}</span>
        </div>
      ))}
    </div>
  );
}

export function Legend({ items }: { items: Array<{ label: string; color?: string; hatched?: boolean }> }) {
  return (
    <span className="lc-legend">
      {items.map((it) => (
        <span key={it.label}>
          <i
            style={
              it.hatched
                ? { background: 'repeating-linear-gradient(45deg,var(--lc-accent-light) 0 2px,var(--lc-accent-soft) 2px 4px)', border: '1px solid var(--lc-accent-light)' }
                : { background: it.color ?? 'var(--lc-accent)' }
            }
          />
          {it.label}
        </span>
      ))}
    </span>
  );
}

/** Horizontal share bars (design: revenue by source). */
export function ShareBars({ rows }: { rows: Array<{ name: string; value: ReactNode; pct: number }> }) {
  return (
    <div className="lc-stack" style={{ gap: 14 }}>
      {rows.map((r) => (
        <div key={r.name} style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', gap: 12, fontSize: 13 }}>
            <span>{r.name}</span>
            <span className="lc-mono" style={{ color: 'var(--lc-text-2)' }}>
              {r.value} <span style={{ color: 'var(--lc-faint)' }}>· {Math.round(r.pct)}%</span>
            </span>
          </div>
          <div className="lc-meter">
            <div style={{ width: `${Math.max(0, Math.min(100, r.pct))}%` }} />
          </div>
        </div>
      ))}
    </div>
  );
}

export type Series = { name: string; points: Array<{ x: string; y: number }>; color?: string; dashed?: boolean };

/**
 * Multi-series line chart in SVG. x values are ISO dates (sorted); the chart
 * spaces them evenly, which suits daily rollups.
 */
export function LineChart({ series, height = 220, format = (v: number) => compact(v) }: { series: Series[]; height?: number; format?: (v: number) => string }) {
  const W = 720;
  const H = height;
  const pad = { l: 48, r: 12, t: 12, b: 26 };
  const xs = [...new Set(series.flatMap((s) => s.points.map((p) => p.x)))].sort();
  if (xs.length === 0) return <div className="lc-table-empty">No data for this range yet.</div>;
  const ys = series.flatMap((s) => s.points.map((p) => p.y));
  const min = Math.min(0, ...ys);
  const max = Math.max(1, ...ys);
  const x = (v: string) => pad.l + (xs.length === 1 ? (W - pad.l - pad.r) / 2 : (xs.indexOf(v) / (xs.length - 1)) * (W - pad.l - pad.r));
  const y = (v: number) => pad.t + (1 - (v - min) / (max - min || 1)) * (H - pad.t - pad.b);
  const ticks = [0, 0.25, 0.5, 0.75, 1].map((t) => min + t * (max - min));
  const labelEvery = Math.max(1, Math.ceil(xs.length / 8));

  return (
    <svg className="lc-chart-svg" viewBox={`0 0 ${W} ${H}`} role="img" preserveAspectRatio="none" style={{ height }}>
      {ticks.map((t, i) => (
        <g key={i}>
          <line className="lc-chart-grid" x1={pad.l} x2={W - pad.r} y1={y(t)} y2={y(t)} />
          <text x={pad.l - 6} y={y(t) + 3} textAnchor="end">
            {format(t)}
          </text>
        </g>
      ))}
      {xs.map((v, i) =>
        // Every nth label, plus the last one unless it would collide with the previous label.
        i % labelEvery === 0 || (i === xs.length - 1 && i % labelEvery >= labelEvery / 2) ? (
          <text key={v} x={x(v)} y={H - 8} textAnchor="middle">
            {v.slice(5)}
          </text>
        ) : null,
      )}
      {series.map((s, si) => {
        const color = s.color ?? SERIES[(si + 1) % SERIES.length];
        const pts = s.points.filter((p) => xs.includes(p.x)).sort((a, b) => (a.x < b.x ? -1 : 1));
        if (pts.length === 0) return null;
        const d = pts.map((p, i) => `${i === 0 ? 'M' : 'L'}${x(p.x).toFixed(1)},${y(p.y).toFixed(1)}`).join(' ');
        return (
          <g key={s.name}>
            <path d={d} fill="none" stroke={color} strokeWidth={1.75} strokeDasharray={s.dashed ? '4 3' : undefined} vectorEffect="non-scaling-stroke" />
            {pts.length <= 40 && pts.map((p) => <circle key={p.x} cx={x(p.x)} cy={y(p.y)} r={2} fill={color}><title>{`${s.name} · ${p.x}: ${format(p.y)}`}</title></circle>)}
          </g>
        );
      })}
    </svg>
  );
}

/** Tiny inline trend for table cells. */
export function Sparkline({ values, width = 80, height = 22 }: { values: number[]; width?: number; height?: number }) {
  if (values.length < 2) return <span className="lc-muted">—</span>;
  const min = Math.min(...values);
  const max = Math.max(...values);
  const d = values.map((v, i) => `${i === 0 ? 'M' : 'L'}${((i / (values.length - 1)) * width).toFixed(1)},${(height - 2 - ((v - min) / (max - min || 1)) * (height - 4)).toFixed(1)}`).join(' ');
  return (
    <svg width={width} height={height} aria-hidden>
      <path d={d} fill="none" stroke="var(--lc-accent)" strokeWidth={1.5} />
    </svg>
  );
}
