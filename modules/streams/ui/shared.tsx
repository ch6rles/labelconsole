import type { TimeRange, TimeSeries } from '@labelconsole/ui/timeseries';
import { platformLabel, SOURCE_LABEL } from '../sources/types';
import type { StreamSource } from '../schema';

export const STATUS_CHIP: Record<string, { label: string; className: string }> = {
  tracking: { label: 'Tracking', className: 'lc-chip lc-chip--blue' },
  pending_match: { label: 'Needs a match', className: 'lc-chip lc-chip--ink' },
  paused: { label: 'Paused', className: 'lc-chip lc-chip--muted' },
};

/**
 * One fixed colour per platform on every chart, from a categorical palette
 * checked for colour-blind separation (blue, orange, aqua, yellow, magenta,
 * green, violet, red). Platforms beyond those share a neutral "other" grey.
 */
const PLATFORM_COLOR: Record<string, string> = {
  spotify: '#2a78d6',
  youtube: '#eb6834',
  apple_music: '#1baf7a',
  amazon_music: '#eda100',
  deezer: '#e87ba4',
  tidal: '#008300',
  tiktok: '#4a3aa7',
  soundcloud: '#e34948',
};
const OTHER_COLOR = '#94a3b8';
export const platformColor = (p: string) => PLATFORM_COLOR[p] ?? OTHER_COLOR;

/**
 * Stream history series as chart lines. The first reading of a series is a
 * running total with no plays figure yet, so its per-day value is left empty.
 * Two sources for one platform (the API and the scraper, say) can't share a
 * colour, so the second takes the first colour no other line uses.
 */
export function historyLines(series: Array<{ platform: string; source: string; since: string | null; points: Array<{ day: string; total: number; delta: number }> }>, granularity: 'day' | 'week' | 'month' = 'day'): TimeSeries[] {
  const used = new Set<string>();
  return series.map((s) => {
    let color = platformColor(s.platform);
    if (used.has(color)) color = Object.values(PLATFORM_COLOR).find((c) => !used.has(c)) ?? OTHER_COLOR;
    used.add(color);
    // The bucket holding the first reading: a day is just that reading; a week or month only when nothing else was played in it.
    const first = s.since ? s.points.filter((p) => p.day <= s.since!).at(-1) : undefined;
    const unique = series.filter((o) => o.platform === s.platform).length === 1;
    return {
      id: `${s.platform}-${s.source}`,
      name: seriesName(s.platform, s.source),
      short: unique ? platformLabel(s.platform) : seriesName(s.platform, s.source),
      color,
      points: s.points.map((p) => ({ day: p.day, total: Number(p.total), delta: p === first && (granularity === 'day' || Number(p.delta) === 0) ? null : Number(p.delta) })),
    };
  });
}

/** Range chips for charts that load 90 days and filter in the browser. */
export const PLAY_RANGES: TimeRange[] = [
  { label: '7 d', days: 7 },
  { label: '28 d', days: 28 },
  { label: '90 d', days: 90 },
];

/**
 * Overview rows (plays per platform per day, no totals) as chart lines. A
 * platform's first day at zero is its first reading, not a day without
 * plays, so it is left out rather than drawn as a dip.
 */
export function platformLines(rows: Array<{ day: string; platform: string; plays: number }>): TimeSeries[] {
  const platforms = [...new Set(rows.map((r) => r.platform))];
  return platforms.map((p) => ({
    id: p,
    name: platformLabel(p),
    color: platformColor(p),
    points: rows.filter((r) => r.platform === p).map((r, i) => ({ day: r.day, total: null, delta: i === 0 && Number(r.plays) === 0 ? null : Number(r.plays) })),
  }));
}

export const seriesName = (platform: string, source: string) => `${platformLabel(platform)} · ${SOURCE_LABEL[source as StreamSource] ?? source}`;
