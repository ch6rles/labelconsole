'use client';

import { useEffect, useMemo, useRef, useState, type KeyboardEvent, type PointerEvent } from 'react';
import { compact, int } from './format';

/**
 * Plays over time, the way people read stream analytics: per day or as the
 * running total, with a crosshair that reads every series at a date, a
 * summary of the selected range, and a table view of the same numbers.
 *
 * Drawn at its real pixel width (measured), so text never stretches on a
 * phone. Dates are placed on a time scale, so a missing day shows as a gap
 * rather than being squeezed out.
 */
export type TimePoint = { day: string; total: number | null; delta: number | null };
/** `short` names the line where space is tight (the tooltip), e.g. "Spotify" for "Spotify · SpotScraper". */
export type TimeSeries = { id: string; name: string; short?: string; color: string; points: TimePoint[] };
type Metric = 'daily' | 'total';
export type TimeRange = { label: string; days: number | null };

const DAY_MS = 86_400_000;
const ms = (day: string) => Date.parse(`${day.slice(0, 10)}T00:00:00Z`);
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const shortDate = (day: string) => `${MONTHS[Number(day.slice(5, 7)) - 1]} ${Number(day.slice(8, 10))}`;
const longDate = (day: string) => `${shortDate(day)}, ${day.slice(0, 4)}`;

/** 1-2-5 steps: clean tick values like 0 / 2K / 4K. */
function niceStep(span: number, count: number) {
  const raw = span / Math.max(1, count);
  const mag = 10 ** Math.floor(Math.log10(raw || 1));
  const n = raw / mag;
  return (n <= 1 ? 1 : n <= 2 ? 2 : n <= 5 ? 5 : 10) * mag;
}

function niceDomain(lo: number, hi: number, count: number, fromZero: boolean): { min: number; max: number; ticks: number[] } {
  if (fromZero) lo = Math.min(0, lo);
  if (hi === lo) hi = lo + (Math.abs(lo) || 1);
  const step = niceStep(hi - lo, count);
  const min = Math.floor(lo / step) * step;
  const max = Math.ceil(hi / step) * step;
  const ticks: number[] = [];
  for (let v = min; v <= max + step / 2; v += step) ticks.push(Number(v.toFixed(6)));
  return { min, max, ticks };
}

const valueOf = (p: TimePoint, metric: Metric) => (metric === 'daily' ? p.delta : p.total);

export function TimeSeriesChart({
  series,
  defaultMetric = 'daily',
  ranges,
  defaultRange,
  unit = 'day',
  height = 240,
  title,
  metrics = ['daily', 'total'],
  totalLabel = 'Total plays',
  summary: showSummary = true,
  rangeLabel,
}: {
  series: TimeSeries[];
  defaultMetric?: Metric;
  /** Which lines can be shown; one without data is left out. */
  metrics?: Metric[];
  /** The name of the running-total line (for a level like monthly listeners). */
  totalLabel?: string;
  /** The range summary above the plot (plays figures only). */
  summary?: boolean;
  /** Range presets filtered here (the data must cover the longest one). Omit when the page sets the range. */
  ranges?: TimeRange[];
  defaultRange?: number | null;
  /** The bucket each point stands for: plays per day, week or month. */
  unit?: 'day' | 'week' | 'month';
  height?: number;
  title?: string;
  /** Names the range the page chose, when it isn't set by the chips here (e.g. "28 d"). */
  rangeLabel?: string;
}) {
  const offered = metrics.filter((m) => series.some((s) => s.points.some((p) => valueOf(p, m) != null)));
  // A newly tracked song has one day of plays but two readings of its total: open on the line that has a shape.
  const daysWith = (m: Metric) => new Set(series.flatMap((s) => s.points.filter((p) => valueOf(p, m) != null).map((p) => p.day))).size;
  const [chosen, setMetric] = useState<Metric>(() => (defaultMetric === 'daily' && metrics.includes('total') && daysWith('daily') < 2 && daysWith('total') > daysWith('daily') ? 'total' : defaultMetric));
  const metric: Metric = offered.includes(chosen) ? chosen : (offered[0] ?? chosen);
  const [range, setRange] = useState<number | null>(defaultRange ?? ranges?.[ranges.length - 1]?.days ?? null);
  const [table, setTable] = useState(false);
  const [hover, setHover] = useState<number | null>(null);
  const [width, setWidth] = useState<number | null>(null);
  const box = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const el = box.current;
    if (!el) return;
    const measure = () => setWidth(Math.round(el.getBoundingClientRect().width));
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  // Range filter, then the union of dates across series (each series keeps its own points).
  const view = useMemo(() => {
    const allDays = series.flatMap((s) => s.points.map((p) => p.day));
    const last = allDays.length ? allDays.reduce((a, b) => (a > b ? a : b)) : null;
    const from = range && last ? new Date(ms(last) - (range - 1) * DAY_MS).toISOString().slice(0, 10) : null;
    const inRange = series.map((s) => ({ ...s, points: s.points.filter((p) => !from || p.day >= from).sort((a, b) => a.day.localeCompare(b.day)) }));
    const days = [...new Set(inRange.flatMap((s) => s.points.filter((p) => valueOf(p, metric) != null).map((p) => p.day)))].sort();
    return { series: inRange, days };
  }, [series, range, metric]);

  // Summary of the selected range (always from the per-day figures, whichever line is shown).
  const summary = useMemo(() => {
    const byDay = new Map<string, number>();
    for (const s of view.series) for (const p of s.points) if (p.delta != null) byDay.set(p.day, (byDay.get(p.day) ?? 0) + p.delta);
    const days = [...byDay.entries()].sort((a, b) => a[0].localeCompare(b[0]));
    const plays = days.reduce((a, [, v]) => a + v, 0);
    const best = days.reduce<[string, number] | null>((b, d) => (!b || d[1] > b[1] ? d : b), null);
    const latestTotal = view.series.reduce((a, s) => a + ([...s.points].reverse().find((p) => p.total != null)?.total ?? 0), 0);
    return { plays, days: days.length, average: days.length ? plays / days.length : null, best, latestTotal };
  }, [view]);

  const W = width ?? 0;
  const H = height;
  const values = view.series.flatMap((s) => s.points.map((p) => valueOf(p, metric)).filter((v): v is number => v != null));
  const domain = niceDomain(values.length ? Math.min(...values) : 0, values.length ? Math.max(...values) : 1, H < 200 ? 3 : 4, metric === 'daily');
  const labelChars = Math.max(...domain.ticks.map((t) => compact(t).length), 2);
  const endLabels = view.series.length <= 4 && W >= 480;
  const pad = { l: labelChars * 7 + 12, r: endLabels ? 52 : 14, t: 14, b: 28 };
  const innerW = Math.max(10, W - pad.l - pad.r);
  const innerH = H - pad.t - pad.b;
  const t0 = view.days.length ? ms(view.days[0]) : 0;
  const t1 = view.days.length ? ms(view.days[view.days.length - 1]) : 1;
  const x = (day: string) => pad.l + (view.days.length <= 1 ? innerW / 2 : ((ms(day) - t0) / (t1 - t0)) * innerW);
  const y = (v: number) => pad.t + (1 - (v - domain.min) / (domain.max - domain.min || 1)) * innerH;

  // A line breaks where readings are missing for more than two of the usual intervals.
  const intervals = view.days.slice(1).map((d, i) => ms(d) - ms(view.days[i]));
  const usual = intervals.length ? [...intervals].sort((a, b) => a - b)[Math.floor(intervals.length / 2)] : DAY_MS;
  const paths = view.series.map((s) => {
    const pts = s.points.filter((p) => valueOf(p, metric) != null);
    let d = '';
    pts.forEach((p, i) => {
      const gap = i > 0 && ms(p.day) - ms(pts[i - 1].day) > usual * 2;
      d += `${i === 0 || gap ? 'M' : 'L'}${x(p.day).toFixed(1)},${y(valueOf(p, metric)!).toFixed(1)}`;
    });
    return { s, pts, d };
  });

  // Date ticks: about one per 80px, on whole intervals.
  const tickEvery = Math.max(1, Math.ceil(view.days.length / Math.max(2, Math.floor(innerW / 80))));
  const xTicks = view.days.filter((_, i) => i % tickEvery === 0);
  if (view.days.length > 1 && xTicks[xTicks.length - 1] !== view.days[view.days.length - 1] && innerW / Math.max(1, xTicks.length) > 60) {
    const lastX = x(view.days[view.days.length - 1]);
    if (lastX - x(xTicks[xTicks.length - 1]) > 56) xTicks.push(view.days[view.days.length - 1]);
  }
  const dateLabel = (day: string) => (unit === 'month' ? `${MONTHS[Number(day.slice(5, 7)) - 1]} ’${day.slice(2, 4)}` : shortDate(day));

  const hoverDay = hover != null ? view.days[hover] : null;
  const readout = hoverDay
    ? view.series.map((s) => ({ s, p: s.points.find((p) => p.day === hoverDay) })).filter((r) => r.p && valueOf(r.p, metric) != null)
    : [];

  const pick = (e: PointerEvent<SVGRectElement>) => {
    if (!view.days.length) return;
    const rect = (e.currentTarget.ownerSVGElement ?? e.currentTarget).getBoundingClientRect();
    const px = e.clientX - rect.left;
    let best = 0;
    for (let i = 1; i < view.days.length; i++) if (Math.abs(x(view.days[i]) - px) < Math.abs(x(view.days[best]) - px)) best = i;
    setHover(best);
  };
  const onKey = (e: KeyboardEvent<HTMLDivElement>) => {
    if (!view.days.length) return;
    if (e.key === 'ArrowLeft' || e.key === 'ArrowRight') {
      e.preventDefault();
      const cur = hover ?? view.days.length - 1;
      setHover(Math.max(0, Math.min(view.days.length - 1, cur + (e.key === 'ArrowLeft' ? -1 : 1))));
    } else if (e.key === 'Escape') setHover(null);
  };

  // End labels: the latest value beside each line, dropped when two would collide.
  const ends = paths.filter((p) => p.pts.length).map((p) => ({ id: p.s.id, yy: y(valueOf(p.pts[p.pts.length - 1], metric)!), xx: x(p.pts[p.pts.length - 1].day), v: valueOf(p.pts[p.pts.length - 1], metric)!, color: p.s.color }));
  const endsClash = ends.some((a, i) => ends.some((b, j) => j > i && Math.abs(a.yy - b.yy) < 14));
  const unitWord = unit === 'day' ? 'day' : unit;
  const multi = view.series.length > 1;
  const tooltipLeft = hoverDay ? x(hoverDay) : 0;
  const flip = tooltipLeft > W / 2;
  // Half the plot less a margin, so the tooltip always fits on the side away from the crosshair.
  const tipMax = Math.max(120, W / 2 - 16);
  const only1 = metric === 'daily' && view.days.length === 1;

  return (
    <div className="lc-ts">
      <div className="lc-ts-controls">
        {offered.length > 1 && (
          <div className="lc-ts-toggle" role="group" aria-label="What to plot">
            <button type="button" className={`lc-tab${metric === 'daily' ? ' is-active' : ''}`} aria-pressed={metric === 'daily'} onClick={() => setMetric('daily')}>
              Plays per {unitWord}
            </button>
            <button type="button" className={`lc-tab${metric === 'total' ? ' is-active' : ''}`} aria-pressed={metric === 'total'} onClick={() => setMetric('total')}>
              {totalLabel}
            </button>
          </div>
        )}
        {ranges && ranges.length > 1 && (
          <div className="lc-ts-toggle" role="group" aria-label="Range">
            {ranges.map((r) => (
              <button key={r.label} type="button" className={`lc-tab${range === r.days ? ' is-active' : ''}`} aria-pressed={range === r.days} onClick={() => setRange(r.days)}>
                {r.label}
              </button>
            ))}
          </div>
        )}
      </div>

      {showSummary && (
        <dl className="lc-ts-summary">
          <div>
            <dt>Plays · {(ranges && range ? ranges.find((r) => r.days === range)?.label : rangeLabel) ?? 'in range'}</dt>
            <dd>{summary.days ? int(Math.round(summary.plays)) : '—'}</dd>
          </div>
          <div>
            <dt>Average per {unitWord}</dt>
            <dd>{summary.average != null ? int(Math.round(summary.average)) : '—'}</dd>
          </div>
          <div>
            <dt>Best {unitWord}</dt>
            <dd>{summary.best ? int(Math.round(summary.best[1])) : '—'}{summary.best && <span>{unit === 'month' ? dateLabel(summary.best[0]) : shortDate(summary.best[0])}</span>}</dd>
          </div>
          {summary.latestTotal > 0 && (
            <div>
              <dt>All-time total</dt>
              <dd>{int(summary.latestTotal)}</dd>
            </div>
          )}
        </dl>
      )}

      {multi && (
        <ul className="lc-ts-legend">
          {view.series.map((s) => {
            // Beside each name: its plays in the range, or its latest total when totals are shown.
            const vals = s.points.map((p) => valueOf(p, metric)).filter((v): v is number => v != null);
            const v = metric === 'daily' ? (vals.length ? vals.reduce((a, b) => a + b, 0) : null) : (vals.at(-1) ?? null);
            return (
              <li key={s.id}>
                <i style={{ background: s.color }} aria-hidden />
                <span>{s.name}</span>
                {v != null && <b>{compact(v)}</b>}
              </li>
            );
          })}
        </ul>
      )}

      <div ref={box} className="lc-ts-plot" style={{ height: H }} tabIndex={0} role="img" aria-label={`${title ?? 'Plays'}: ${metric === 'daily' ? `plays per ${unitWord}` : totalLabel.toLowerCase()}. Use the arrow keys to read each ${unitWord}.`} onKeyDown={onKey} onBlur={() => setHover(null)}>
        {width != null && view.days.length === 0 && <div className="lc-ts-empty">{metric === 'daily' ? `Plays per ${unitWord} start from the second reading.` : 'No readings in this range yet.'}</div>}
        {width != null && view.days.length > 0 && (
          <svg width={W} height={H} viewBox={`0 0 ${W} ${H}`} className="lc-ts-svg">
            {domain.ticks.map((t) => (
              <g key={t}>
                <line className="lc-ts-grid" x1={pad.l} x2={W - pad.r} y1={y(t)} y2={y(t)} />
                <text className="lc-ts-axis" x={pad.l - 8} y={y(t) + 4} textAnchor="end">
                  {compact(t)}
                </text>
              </g>
            ))}
            {xTicks.map((d) => (
              <text key={d} className="lc-ts-axis" x={x(d)} y={H - 8} textAnchor={view.days.length === 1 ? 'middle' : d === view.days[0] ? 'start' : d === view.days[view.days.length - 1] ? 'end' : 'middle'}>
                {dateLabel(d)}
              </text>
            ))}
            {/* A wash under a single per-day line, which starts at zero; never under totals, which don't. */}
            {!multi && metric === 'daily' && paths[0]?.pts.length > 1 && (
              <path d={`${paths[0].d} L${x(paths[0].pts[paths[0].pts.length - 1].day).toFixed(1)},${y(Math.max(0, domain.min)).toFixed(1)} L${x(paths[0].pts[0].day).toFixed(1)},${y(Math.max(0, domain.min)).toFixed(1)} Z`} fill={paths[0].s.color} opacity={0.1} />
            )}
            {paths.map(({ s, d, pts }) => (
              <g key={s.id}>
                {pts.length > 1 && <path d={d} fill="none" stroke={s.color} strokeWidth={2} strokeLinejoin="round" strokeLinecap="round" />}
                {pts.length > 0 && (pts.length === 1 || hover == null) && (
                  <circle cx={x(pts[pts.length - 1].day)} cy={y(valueOf(pts[pts.length - 1], metric)!)} r={4} fill={s.color} stroke="var(--lc-surface)" strokeWidth={2} />
                )}
              </g>
            ))}
            {endLabels && !endsClash && hover == null && ends.map((e) => (
              <text key={e.id} className="lc-ts-end" x={e.xx + 8} y={e.yy + 4}>
                {compact(e.v)}
              </text>
            ))}
            {hoverDay && (
              <g pointerEvents="none">
                <line className="lc-ts-cross" x1={x(hoverDay)} x2={x(hoverDay)} y1={pad.t} y2={H - pad.b} />
                {readout.map(({ s, p }) => (
                  <circle key={s.id} cx={x(hoverDay)} cy={y(valueOf(p!, metric)!)} r={4.5} fill={s.color} stroke="var(--lc-surface)" strokeWidth={2} />
                ))}
              </g>
            )}
            <rect x={pad.l - 10} y={0} width={innerW + 20} height={H} fill="transparent" style={{ touchAction: 'pan-y' }} onPointerMove={pick} onPointerDown={pick} onPointerLeave={(e) => e.pointerType === 'mouse' && setHover(null)} />
          </svg>
        )}
        {hoverDay && readout.length > 0 && (
          <div className="lc-ts-tip" style={{ ...(flip ? { right: W - tooltipLeft + 12 } : { left: tooltipLeft + 12 }), maxWidth: tipMax }} role="status">
            <div className="lc-ts-tip-date">{unit === 'month' ? dateLabel(hoverDay) : longDate(hoverDay)}</div>
            {readout.map(({ s, p }) => (
              <div key={s.id} className="lc-ts-tip-row">
                <i style={{ background: s.color }} aria-hidden />
                <b>{int(valueOf(p!, metric)!)}</b>
                <span>{s.short ?? s.name}</span>
              </div>
            ))}
            {multi && readout.length > 1 && (
              <div className="lc-ts-tip-row lc-ts-tip-total">
                <b>{int(readout.reduce((a, r) => a + (valueOf(r.p!, metric) ?? 0), 0))}</b>
                <span>All sources</span>
              </div>
            )}
          </div>
        )}
      </div>
      <div className="lc-ts-foot">
        <p className="lc-ts-note">{only1 ? `One ${unitWord} of plays so far: each new reading adds a point.` : ''}</p>
        <button type="button" className="lc-btn lc-btn--sm lc-btn--ghost" aria-pressed={table} onClick={() => setTable((t) => !t)}>
          {table ? 'Hide table' : 'Show as table'}
        </button>
      </div>

      {table && (
        <div className="lc-ts-table">
          <table>
            <thead>
              <tr>
                <th>{unit === 'month' ? 'Month' : unit === 'week' ? 'Week of' : 'Date'}</th>
                {view.series.map((s) => (
                  <th key={s.id}>
                    <i style={{ background: s.color }} aria-hidden />
                    {s.name}
                  </th>
                ))}
                {multi && <th>All sources</th>}
              </tr>
            </thead>
            <tbody>
              {[...view.days].reverse().map((d) => {
                const cells = view.series.map((s) => s.points.find((p) => p.day === d));
                const vals = cells.map((p) => (p ? valueOf(p, metric) : null));
                return (
                  <tr key={d}>
                    <td>{unit === 'month' ? dateLabel(d) : longDate(d)}</td>
                    {vals.map((v, i) => (
                      <td key={i}>{v != null ? int(v) : '—'}</td>
                    ))}
                    {multi && <td>{vals.some((v) => v != null) ? int(vals.reduce<number>((a, v) => a + (v ?? 0), 0)) : '—'}</td>}
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
