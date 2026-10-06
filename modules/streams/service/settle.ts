/**
 * Turning running totals into plays per day when the platform refreshes late.
 *
 * Spotify (and at times YouTube) refreshes the public count about once a day,
 * not at a fixed time, and now and then skips a day. Read as is, a reading
 * that hasn't moved says "0 plays" and the next one says "two days of plays":
 * a false drop, then a false spike. So, per series:
 *
 * - An unchanged count within a week of the last growth is **pending**: the
 *   plays aren't known yet, and they are never shown or alerted on as 0.
 * - When the count moves again, the increase is spread evenly over the days
 *   since the last settled reading (the pending days, days with no reading at
 *   all, and the day it arrived), marked **estimated**. The total over those
 *   days is exact; only the split between them is estimated.
 * - A count unchanged for longer than a week is taken at its word: those days
 *   had no plays.
 *
 * Readings are the inputs (their change as read is kept separately), so
 * settling again always gives the same result.
 */
export type DailyReading = { day: string; total: number; rawDelta: number | null };
export type SettledDay = { day: string; total: number; delta: number; estimated: boolean; pending: boolean; filled: boolean };

/** How long after the last growth an unchanged count still means "not refreshed yet". */
export const PENDING_DAYS = 7;
/** Plays are never spread further back than this. */
export const MAX_SPREAD_DAYS = 31;

const DAY_MS = 86_400_000;
export const addDays = (day: string, n: number) => new Date(Date.parse(`${day}T00:00:00Z`) + n * DAY_MS).toISOString().slice(0, 10);
const daysBetween = (a: string, b: string) => Math.round((Date.parse(`${b}T00:00:00Z`) - Date.parse(`${a}T00:00:00Z`)) / DAY_MS);

export function settle(rows: DailyReading[]): SettledDay[] {
  // Days the tracker filled in itself are outputs, not readings.
  const readings = rows.filter((r): r is DailyReading & { rawDelta: number } => r.rawDelta !== null).sort((a, b) => a.day.localeCompare(b.day));
  const out = new Map<string, SettledDay>();
  const plain = (r: DailyReading & { rawDelta: number }): SettledDay => ({ day: r.day, total: r.total, delta: Math.max(0, r.rawDelta), estimated: false, pending: false, filled: false });
  let anchor: { day: string; total: number } | null = null;
  let lastGrowth: string | null = null;
  let run: Array<DailyReading & { rawDelta: number }> = [];

  for (const r of readings) {
    if (!anchor) {
      out.set(r.day, plain(r));
      anchor = r;
      if (r.rawDelta > 0) lastGrowth = r.day;
      continue;
    }
    if (r.rawDelta > 0) {
      const span = daysBetween(anchor.day, r.day);
      if (span <= 1 || span > MAX_SPREAD_DAYS) out.set(r.day, plain(r));
      else {
        const per = Math.floor(r.rawDelta / span);
        const extra = r.rawDelta - per * span;
        let total = anchor.total;
        for (let i = 1; i <= span; i++) {
          const day = addDays(anchor.day, i);
          const share = per + (i > span - extra ? 1 : 0);
          total += share;
          out.set(day, { day, total: i === span ? r.total : total, delta: share, estimated: true, pending: false, filled: !readings.some((x) => x.day === day) });
        }
      }
      anchor = r;
      lastGrowth = r.day;
      run = [];
    } else if (lastGrowth !== null && daysBetween(lastGrowth, r.day) <= PENDING_DAYS) {
      out.set(r.day, { ...plain(r), delta: 0, pending: true });
      run.push(r);
    } else {
      // Still unchanged a week after the last growth: these days really had no plays.
      for (const p of [...run, r]) out.set(p.day, { ...plain(p), delta: 0 });
      anchor = r;
      run = [];
    }
  }
  return [...out.values()].sort((a, b) => a.day.localeCompare(b.day));
}
