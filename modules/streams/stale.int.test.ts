import { and, eq } from 'drizzle-orm';
import { afterAll, describe, expect, it } from 'vitest';
import '../../test/modules';
import { closeDb } from '@labelconsole/core/db/client';
import { closeQueues } from '@labelconsole/core/queue';
import { closeRedis } from '@labelconsole/core/redis';
import { createTrack } from '@labelconsole/catalogue/service';
import { createArtist } from '@labelconsole/people/service';
import { makeOrg, type TestOrg } from '../../test/helpers';
import { alerts, streamDaily } from './schema';
import * as svc from './service';

afterAll(async () => {
  await closeQueues();
  await closeDb();
  await closeRedis();
});

const DAY = 86_400_000;
const dayOf = (n: number) => new Date(Date.now() - n * DAY).toISOString().slice(0, 10);
/** A Spotify reading at midday, n days ago. */
const reading = (trackId: string, n: number, count: number) => ({ trackId, platform: 'spotify', source: 'spotscraper' as const, externalId: '4PTG3Z6ehGkBFwjybzWkR8', capturedAt: new Date(`${dayOf(n)}T12:00:00Z`), count });

async function setup(a: TestOrg) {
  return a.as(async (ctx) => {
    await svc.ensureDefaultRules(ctx);
    const artist = await createArtist(ctx, { name: 'vexsyn', status: 'active' });
    return createTrack(ctx, { title: 'Ainsi Bas La Vida Hardtekk', artistIds: [artist.id] });
  });
}

describe('Late Spotify refreshes', () => {
  it('shows a day Spotify did not refresh as pending, never as 0 plays, and raises no drop alert', async () => {
    const a = await makeOrg('Stale Label');
    const track = await setup(a);
    // About 1,500 plays a day; no poll ran four days ago; yesterday Spotify still showed the day before's count.
    const counts: Array<[number, number]> = [[8, 40_000], [7, 41_500], [6, 43_000], [5, 44_500], [3, 47_500], [2, 49_000], [1, 49_000]];
    for (const [n, c] of counts) await a.as((ctx) => svc.recordSnapshots(ctx, [reading(track.id, n, c)]));

    const yesterday = await a.as(async (ctx) => (await ctx.tx.select().from(streamDaily).where(and(eq(streamDaily.trackId, track.id), eq(streamDaily.day, dayOf(1)))))[0]);
    expect(yesterday).toMatchObject({ delta: 0, rawDelta: 0, pending: true, estimated: false, total: 49_000 });
    // A drop alert raised before settling (on the 0) is withdrawn once the day is known to be a late refresh.
    await a.as((ctx) => ctx.tx.insert(alerts).values({ trackId: track.id, kind: 'drop', platform: 'spotify', day: dayOf(1), value: 0, baseline: 1_500, message: 'Spotify plays down 100%' }));
    await a.as((ctx) => svc.recordSnapshots(ctx, [reading(track.id, 1, 49_000)]));
    expect(await a.as((ctx) => ctx.tx.select().from(alerts))).toEqual([]);
    expect(await a.as((ctx) => svc.evaluateTrackAlerts(ctx, track.id, 'spotify', 'spotscraper'))).toEqual([]);

    const h = await a.as((ctx) => svc.trackHistory(ctx, track.id, { from: dayOf(10) }));
    const points = h.series[0].points.map((p) => [p.day, p.delta, p.pending ? 'pending' : p.estimated ? 'estimated' : 'read']);
    // The missed poll is filled in rather than doubling the next day.
    expect(points).toEqual([
      [dayOf(8), 0, 'read'],
      [dayOf(7), 1_500, 'read'],
      [dayOf(6), 1_500, 'read'],
      [dayOf(5), 1_500, 'read'],
      [dayOf(4), 1_500, 'estimated'],
      [dayOf(3), 1_500, 'estimated'],
      [dayOf(2), 1_500, 'read'],
      [dayOf(1), 0, 'pending'],
    ]);
    // Agents see no figure for the pending day, flagged as such.
    const agent = await a.as((ctx) => svc.historyForAgent(ctx, { trackId: track.id, days: 10 }));
    expect(agent[0].points.at(-1)).toEqual({ day: dayOf(1), value: null, pending: true });

    // Today Spotify catches up with two days of plays: they are spread over both days, and nothing reads as a spike.
    const [today] = await a.as((ctx) => svc.recordSnapshots(ctx, [reading(track.id, 0, 52_100)]));
    expect(today).toMatchObject({ delta: 1_550, estimated: true, pending: false });
    const settled = await a.as((ctx) => svc.trackHistory(ctx, track.id, { from: dayOf(2) }));
    expect(settled.series[0].points.map((p) => [p.day, p.delta, p.total, p.estimated])).toEqual([
      [dayOf(2), 1_500, 49_000, false],
      [dayOf(1), 1_550, 50_550, true],
      [dayOf(0), 1_550, 52_100, true],
    ]);
    expect(await a.as((ctx) => svc.evaluateTrackAlerts(ctx, track.id, 'spotify', 'spotscraper'))).toEqual([]);
    expect(await a.as((ctx) => ctx.tx.select().from(alerts))).toEqual([]);
  });

  it('still reports a real drop once the count is refreshed', async () => {
    const a = await makeOrg('Real Drop Label');
    const track = await setup(a);
    // Steady 1,500 a day, then yesterday only 200 (refreshed, just low).
    for (const [n, c] of [[7, 40_000], [6, 41_500], [5, 43_000], [4, 44_500], [3, 46_000], [2, 47_500], [1, 47_700]] as Array<[number, number]>) await a.as((ctx) => svc.recordSnapshots(ctx, [reading(track.id, n, c)]));
    const hits = await a.as((ctx) => svc.evaluateTrackAlerts(ctx, track.id, 'spotify', 'spotscraper'));
    expect(hits.map((h) => [h.kind, h.day, h.value])).toEqual([['drop', dayOf(1), 200]]);
  });
});
