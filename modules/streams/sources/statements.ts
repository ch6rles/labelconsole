import { platformSlug } from './types';

/**
 * Statement-import adapter: exact counts from distributor statements parsed by
 * Documents. These are the label's ground truth, but they are period totals
 * reported months in arrears, so they are stored under their own source and
 * never mixed into the polled (cumulative) series.
 */
export type StatementLineLike = { trackId: string | null; source: string; periodEnd: string | null; units: number };

export type PeriodTotal = { trackId: string; platform: string; periodEnd: string; units: number };

export function statementPeriodTotals(lines: StatementLineLike[]): PeriodTotal[] {
  const totals = new Map<string, PeriodTotal>();
  for (const l of lines) {
    if (!l.trackId || !l.periodEnd) continue;
    const platform = platformSlug(l.source);
    const key = `${l.trackId}|${platform}|${l.periodEnd}`;
    const t = totals.get(key) ?? { trackId: l.trackId, platform, periodEnd: l.periodEnd, units: 0 };
    t.units += l.units;
    totals.set(key, t);
  }
  // Returns and chargebacks can make a period negative; a count can't be.
  return [...totals.values()].map((t) => ({ ...t, units: Math.max(0, t.units) }));
}
