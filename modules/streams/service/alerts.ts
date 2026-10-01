import type { AlertKind } from '../schema';
import { platformLabel } from '../sources/types';

export type DayPoint = { day: string; total: number; delta: number };
export type RuleLike = { id: string | null; kind: AlertKind; threshold: number; windowDays: number; minDaily: number; platform: string | null };
export type AlertHit = { ruleId: string | null; kind: AlertKind; day: string; value: number; baseline: number | null; message: string };

/** Rules a label starts with; they are stored as rows so they can be edited or switched off. */
export const DEFAULT_RULES: Array<Omit<RuleLike, 'id'> & { name: string }> = [
  { name: 'Daily plays spike', kind: 'spike', threshold: 200, windowDays: 7, minDaily: 200, platform: null },
  { name: 'Daily plays drop', kind: 'drop', threshold: 60, windowDays: 7, minDaily: 1000, platform: null },
  { name: '100K milestone', kind: 'milestone', threshold: 100_000, windowDays: 1, minDaily: 0, platform: null },
  { name: '1M milestone', kind: 'milestone', threshold: 1_000_000, windowDays: 1, minDaily: 0, platform: null },
];

const compact = (n: number) => (n >= 1e6 ? `${(n / 1e6).toFixed(n >= 1e7 ? 0 : 1)}M` : n >= 1e3 ? `${(n / 1e3).toFixed(n >= 1e4 ? 0 : 1)}K` : String(Math.round(n)));
const dayLabel = (d: string) => new Date(`${d}T00:00:00Z`).toLocaleDateString('en-US', { month: 'short', day: 'numeric', timeZone: 'UTC' });
const addDays = (d: string, n: number) => new Date(Date.parse(`${d}T00:00:00Z`) + n * 86400_000).toISOString().slice(0, 10);

/**
 * Evaluate rules for one track and platform.
 * Spikes and drops compare a completed day's plays with the average of the
 * preceding window, so a day still in progress never reads as a drop.
 * Milestones fire on the day the cumulative total first crosses the threshold.
 */
export function evaluateRules(rules: RuleLike[], platform: string, points: DayPoint[], completedDay: string): AlertHit[] {
  const sorted = [...points].sort((a, b) => a.day.localeCompare(b.day));
  const hits: AlertHit[] = [];
  const label = platformLabel(platform);
  for (const r of rules) {
    if (r.platform && r.platform !== platform) continue;
    if (r.kind === 'milestone') {
      const last = sorted.at(-1);
      const prev = sorted.at(-2);
      if (last && prev && prev.total < r.threshold && last.total >= r.threshold) {
        hits.push({ ruleId: r.id, kind: 'milestone', day: last.day, value: last.total, baseline: prev.total, message: `Passed ${compact(r.threshold)} on ${label}` });
      }
      continue;
    }
    const target = sorted.find((p) => p.day === completedDay);
    if (!target) continue;
    const from = addDays(completedDay, -r.windowDays);
    const window = sorted.filter((p) => p.day < completedDay && p.day >= from);
    if (window.length < 3) continue; // not enough history to call anything unusual
    const baseline = window.reduce((a, p) => a + p.delta, 0) / window.length;
    if (r.kind === 'spike') {
      if (target.delta < r.minDaily || baseline <= 0) continue;
      const change = ((target.delta - baseline) / baseline) * 100;
      if (change >= r.threshold) hits.push({ ruleId: r.id, kind: 'spike', day: completedDay, value: target.delta, baseline: Math.round(baseline), message: `${label} plays up ${Math.round(change)}% on ${dayLabel(completedDay)}: ${compact(target.delta)} vs ${compact(baseline)} a day over the previous ${r.windowDays} days` });
    } else if (r.kind === 'drop') {
      if (baseline < r.minDaily) continue;
      const change = ((baseline - target.delta) / baseline) * 100;
      if (change >= r.threshold) hits.push({ ruleId: r.id, kind: 'drop', day: completedDay, value: target.delta, baseline: Math.round(baseline), message: `${label} plays down ${Math.round(change)}% on ${dayLabel(completedDay)}: ${compact(target.delta)} vs ${compact(baseline)} a day over the previous ${r.windowDays} days` });
    }
  }
  return hits;
}

/** Next poll time for a tier: active tracks every 6 hours, back catalogue daily. */
export function nextPollAt(tier: string, from = new Date()) {
  const hours = tier === 'active' ? 6 : 24;
  // A little jitter spreads polls so a whole catalogue doesn't come due in the same minute.
  return new Date(from.getTime() + hours * 3600_000 - Math.floor(Math.random() * 20 * 60_000));
}
