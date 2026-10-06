import { describe, expect, it } from 'vitest';
import { settle, type DailyReading } from './settle';

const r = (day: string, total: number, rawDelta: number | null): DailyReading => ({ day, total, rawDelta });
const view = (rows: ReturnType<typeof settle>) => rows.map((d) => [d.day.slice(5), d.delta, d.pending ? 'pending' : d.estimated ? 'estimated' : 'read', ...(d.filled ? ['filled'] : [])]);

describe('settling plays per day', () => {
  it('keeps steady daily readings as they are', () => {
    expect(view(settle([r('2026-10-01', 1_000, 0), r('2026-10-02', 1_120, 120), r('2026-10-03', 1_230, 110)]))).toEqual([
      ['10-01', 0, 'read'],
      ['10-02', 120, 'read'],
      ['10-03', 110, 'read'],
    ]);
  });

  it('shows a day Spotify did not refresh as pending, then spreads the catch-up over both days', () => {
    // Oct 3 read the same count as Oct 2; Oct 4 carried both days of plays.
    const stale = [r('2026-10-01', 1_000, 0), r('2026-10-02', 1_120, 120), r('2026-10-03', 1_120, 0)];
    expect(view(settle(stale)).at(-1)).toEqual(['10-03', 0, 'pending']);
    const caughtUp = settle([...stale, r('2026-10-04', 1_361, 241)]);
    expect(view(caughtUp)).toEqual([
      ['10-01', 0, 'read'],
      ['10-02', 120, 'read'],
      ['10-03', 120, 'estimated'],
      ['10-04', 121, 'estimated'],
    ]);
    // The running totals stay consistent with the plays, and end on the real reading.
    expect(caughtUp.map((d) => d.total)).toEqual([1_000, 1_120, 1_240, 1_361]);
  });

  it('fills a day with no reading at all (a missed poll) instead of doubling the next day', () => {
    expect(view(settle([r('2026-10-01', 500, 0), r('2026-10-02', 600, 100), r('2026-10-04', 800, 200)]))).toEqual([
      ['10-01', 0, 'read'],
      ['10-02', 100, 'read'],
      ['10-03', 100, 'estimated', 'filled'],
      ['10-04', 100, 'estimated'],
    ]);
  });

  it('gives the same answer when settled again, ignoring the days it filled in', () => {
    const rows = [r('2026-10-01', 500, 0), r('2026-10-02', 600, 100), r('2026-10-04', 800, 200)];
    const first = settle(rows);
    const again = settle([...rows, ...first.filter((d) => d.filled).map((d) => r(d.day, d.total, null))]);
    expect(again).toEqual(first);
  });

  it('takes a count unchanged for over a week at its word', () => {
    const rows = [r('2026-09-01', 50, 0), r('2026-09-02', 51, 1)];
    for (let d = 3; d <= 12; d++) rows.push(r(`2026-09-${String(d).padStart(2, '0')}`, 51, 0));
    const out = settle(rows);
    expect(out.filter((d) => d.pending)).toEqual([]);
    expect(out.slice(2).every((d) => d.delta === 0 && !d.estimated)).toBe(true);
  });

  it('never marks a track that has not grown yet as pending', () => {
    expect(view(settle([r('2026-10-01', 10, 0), r('2026-10-02', 10, 0)]))).toEqual([
      ['10-01', 0, 'read'],
      ['10-02', 0, 'read'],
    ]);
  });
});
