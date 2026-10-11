import type { ChartSeries } from './cards/views';

/**
 * The performance chart as a PNG: daily plays as bars for songs Label Console
 * tracks, or the platform's count at each lookup as a line for any other song.
 * Days without a reading are left empty, never filled in; estimated days are
 * drawn lighter. Drawn as SVG and rasterised with sharp (worker only).
 */

const W = 960;
const H = 420;
const PAD = { top: 56, right: 28, bottom: 52, left: 84 };
const COLORS = { bg: '#1e1f22', grid: '#34363c', text: '#b5bac1', strong: '#e3e5e8', bar: '#748ffc', line: '#748ffc', point: '#c5cefe' };
const FONT = "DejaVu Sans, Inter, 'Helvetica Neue', Arial, sans-serif";

const esc = (s: string) => s.replace(/[<>&'"]/g, (c) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', "'": '&apos;', '"': '&quot;' })[c]!);
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const shortDate = (iso: string) => `${Number(iso.slice(8, 10))} ${MONTHS[Number(iso.slice(5, 7)) - 1]}`;
const DAY = 86_400_000;

export function compact(n: number) {
  const a = Math.abs(n);
  if (a >= 1e9) return `${(n / 1e9).toFixed(a >= 1e10 ? 0 : 1)}B`;
  if (a >= 1e6) return `${(n / 1e6).toFixed(a >= 1e7 ? 0 : 1)}M`;
  if (a >= 1e3) return `${(n / 1e3).toFixed(a >= 1e4 ? 0 : 1)}K`;
  return String(Math.round(n));
}

/** Round numbers for the axis, about four steps. */
export function ticks(min: number, max: number, count = 4): number[] {
  if (max <= min) max = min + 1;
  const raw = (max - min) / count;
  const mag = 10 ** Math.floor(Math.log10(raw));
  const step = [1, 2, 2.5, 5, 10].map((m) => m * mag).find((s) => s >= raw) ?? raw;
  // From the step at or below the lowest value to the one at or above the highest, so the axis covers every point.
  const out: number[] = [];
  const end = Math.ceil(max / step) * step;
  for (let v = Math.floor(min / step) * step; v <= end + step * 0.001; v += step) out.push(Math.round(v * 1e6) / 1e6);
  return out;
}

export function chartSvg(series: ChartSeries, title: string): string {
  const pts = series.points;
  const x0 = PAD.left;
  const x1 = W - PAD.right;
  const y0 = H - PAD.bottom;
  const y1 = PAD.top;
  const values = pts.map((p) => p.value);
  const lo = series.kind === 'daily' ? 0 : Math.min(...values);
  const hi = Math.max(...values, lo + 1);
  const yt = ticks(series.kind === 'daily' ? 0 : lo - (hi - lo) * 0.05, hi + (hi - lo) * 0.05);
  const yMin = yt[0];
  const yMax = yt[yt.length - 1];
  const y = (v: number) => y0 - ((v - yMin) / (yMax - yMin || 1)) * (y0 - y1);
  // Bars are centred on their day, so daily charts get half a day of room at each end.
  const pad = series.kind === 'daily' ? DAY * 0.6 : 0;
  const t0 = Date.parse(pts[0].at) - pad;
  const t1 = Math.max(Date.parse(pts[pts.length - 1].at) + pad, t0 + DAY);
  const x = (iso: string) => x0 + ((Date.parse(iso) - t0) / (t1 - t0)) * (x1 - x0);
  const parts: string[] = [];
  parts.push(`<rect width="${W}" height="${H}" fill="${COLORS.bg}"/>`);
  parts.push(`<text x="${x0}" y="32" fill="${COLORS.strong}" font-size="20" font-weight="bold">${esc(title)}</text>`);
  parts.push(`<text x="${x1}" y="32" fill="${COLORS.text}" font-size="14" text-anchor="end">${series.kind === 'daily' ? 'Daily plays' : 'Count at each lookup'} · ${esc(series.platform)}</text>`);
  for (const v of yt) {
    parts.push(`<line x1="${x0}" x2="${x1}" y1="${y(v).toFixed(1)}" y2="${y(v).toFixed(1)}" stroke="${COLORS.grid}" stroke-width="1"/>`);
    parts.push(`<text x="${x0 - 10}" y="${(y(v) + 5).toFixed(1)}" fill="${COLORS.text}" font-size="13" text-anchor="end">${compact(v)}</text>`);
  }
  const labels = pts.length > 2 ? [pts[0], pts[Math.floor(pts.length / 2)], pts[pts.length - 1]] : pts;
  for (const [i, p] of labels.entries()) parts.push(`<text x="${x(p.at).toFixed(1)}" y="${y0 + 24}" fill="${COLORS.text}" font-size="13" text-anchor="${i === 0 ? 'start' : i === labels.length - 1 ? 'end' : 'middle'}">${shortDate(p.at)}</text>`);

  if (series.kind === 'daily') {
    const days = Math.max(1, Math.round((t1 - t0) / DAY));
    const bw = Math.max(1.5, ((x1 - x0) / days) * 0.72);
    for (const p of pts) {
      const top = y(Math.max(0, p.value));
      parts.push(`<rect x="${(x(p.at) - bw / 2).toFixed(1)}" y="${top.toFixed(1)}" width="${bw.toFixed(1)}" height="${Math.max(0, y0 - top).toFixed(1)}" fill="${COLORS.bar}" opacity="${p.estimated ? 0.45 : 1}"/>`);
    }
  } else {
    for (let i = 1; i < pts.length; i++) {
      const gap = Date.parse(pts[i].at) - Date.parse(pts[i - 1].at) > 2 * DAY;
      parts.push(`<line x1="${x(pts[i - 1].at).toFixed(1)}" y1="${y(pts[i - 1].value).toFixed(1)}" x2="${x(pts[i].at).toFixed(1)}" y2="${y(pts[i].value).toFixed(1)}" stroke="${COLORS.line}" stroke-width="3" ${gap ? 'stroke-dasharray="6 6" opacity="0.6"' : ''}/>`);
    }
    for (const p of pts) parts.push(`<circle cx="${x(p.at).toFixed(1)}" cy="${y(p.value).toFixed(1)}" r="4.5" fill="${COLORS.point}"/>`);
  }
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}" font-family="${FONT}">${parts.join('')}</svg>`;
}

/** The chart as PNG, or null when there is nothing to draw or sharp is unavailable. */
export async function renderChart(series: ChartSeries | null, title: string): Promise<Buffer | null> {
  if (!series || series.points.length < 2) return null;
  try {
    const sharp = (await import('sharp')).default;
    return await sharp(Buffer.from(chartSvg(series, title))).png().toBuffer();
  } catch {
    return null;
  }
}
