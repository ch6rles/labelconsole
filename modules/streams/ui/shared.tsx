import { SERIES, type Series } from '@labelconsole/ui';
import { platformLabel, SOURCE_LABEL } from '../sources/types';
import type { StreamSource } from '../schema';

export const STATUS_CHIP: Record<string, { label: string; className: string }> = {
  tracking: { label: 'Tracking', className: 'lc-chip lc-chip--blue' },
  pending_match: { label: 'Needs a match', className: 'lc-chip lc-chip--ink' },
  paused: { label: 'Paused', className: 'lc-chip lc-chip--muted' },
};

/** Consistent colours per platform across every chart. */
// SERIES[0] is the ink colour charts reserve for totals; platforms start at the accent.
const PLATFORM_COLOR: Record<string, string> = { youtube: SERIES[1], spotify: SERIES[2], apple_music: SERIES[3] };
export const platformColor = (p: string, i = 0) => PLATFORM_COLOR[p] ?? SERIES[1 + (i % (SERIES.length - 1))];

/** Daily plays per platform, filling missing days with zero so lines don't skip. */
export function playsSeries(rows: Array<{ day: string; platform: string; plays: number }>, days: number): Series[] {
  const end = new Date();
  const axis = Array.from({ length: days }, (_, i) => new Date(end.getTime() - (days - 1 - i) * 86400_000).toISOString().slice(0, 10));
  const platforms = [...new Set(rows.map((r) => r.platform))];
  return platforms.map((p, i) => ({
    name: platformLabel(p),
    color: platformColor(p, i),
    points: axis.map((day) => ({ x: day, y: rows.filter((r) => r.platform === p && r.day === day).reduce((a, r) => a + r.plays, 0) })),
  }));
}

export const seriesName = (platform: string, source: string) => `${platformLabel(platform)} · ${SOURCE_LABEL[source as StreamSource] ?? source}`;
