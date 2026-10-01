import { and, eq } from 'drizzle-orm';
import { afterAll, afterEach, describe, expect, it, vi } from 'vitest';
import '../../test/modules';
import { closeDb, systemDb } from '@labelconsole/core/db/client';
import { domainEvents } from '@labelconsole/core/db/schema';
import { closeQueues, queue } from '@labelconsole/core/queue';
import { closeRedis } from '@labelconsole/core/redis';
import { putCredential } from '@labelconsole/core/vault';
import { createTrack, identitiesFor } from '@labelconsole/catalogue/service';
import { documents, statementLines } from '@labelconsole/documents/schema';
import { createArtist } from '@labelconsole/people/service';
import { makeOrg, runJob } from '../../test/helpers';
import { jobs, NO_YOUTUBE_KEY } from './jobs';
import { alerts, streamDaily, streamTracks } from './schema';
import * as svc from './service';

afterAll(async () => {
  await closeQueues();
  await closeDb();
  await closeRedis();
});
afterEach(() => vi.unstubAllGlobals());

const json = (body: unknown) => new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } });
const DAY = 86400_000;

describe('streams', () => {
  it('polls YouTube views on schedule, rolls up daily plays and raises alerts', async () => {
    const a = await makeOrg();
    const { track, artist } = await a.as(async (ctx) => {
      const artist = await createArtist(ctx, { name: 'Mara Ellis', status: 'active' });
      const track = await createTrack(ctx, { title: 'Tidewater', isrc: 'NLA1Z2600123', durationMs: 214_000, artistIds: [artist.id] });
      await svc.registerTrack(ctx, track.id);
      await putCredential(ctx, { provider: 'youtube', label: 'Label key', secret: { apiKey: 'test-key' } });
      return { track, artist };
    });
    expect((await a.as((ctx) => svc.getTracked(ctx, track.id))).tracked?.status).toBe('pending_match');

    await a.as((ctx) => svc.addVideo(ctx, track.id, { video: 'https://youtu.be/AAAAAAAAAAA' }));
    expect((await a.as((ctx) => svc.getTracked(ctx, track.id))).tracked?.status).toBe('tracking');

    // Nine days of history at ~1,000 plays a day, then a spike yesterday.
    let count = 100_000;
    for (let i = 9; i >= 1; i--) {
      count += i === 1 ? 5_000 : 1_000;
      const capturedAt = new Date(Date.now() - i * DAY);
      await a.as((ctx) => svc.recordSnapshots(ctx, [{ trackId: track.id, platform: 'youtube', source: 'youtube-data-api', externalId: 'AAAAAAAAAAA', capturedAt, count }]));
    }

    const calls: string[] = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string) => {
        calls.push(String(url));
        if (String(url).includes('/youtube/v3/videos')) return json({ items: [{ id: 'AAAAAAAAAAA', statistics: { viewCount: String(count + 1_500) } }] });
        throw new Error(`unexpected fetch ${url}`);
      }),
    );
    await runJob(jobs, 'streams.poll-org', a.org.id);
    expect(calls).toHaveLength(1);
    expect(calls[0]).toContain('part=statistics');
    expect(calls[0]).not.toContain('/search');

    const today = new Date().toISOString().slice(0, 10);
    const [todayRow] = await a.as((ctx) => ctx.tx.select().from(streamDaily).where(and(eq(streamDaily.trackId, track.id), eq(streamDaily.day, today))));
    expect(todayRow).toMatchObject({ platform: 'youtube', source: 'youtube-data-api', total: count + 1_500, delta: 1_500 });

    const tracked = await a.as((ctx) => svc.getTracked(ctx, track.id));
    expect(tracked.tracked?.lastPolledAt).toBeTruthy();
    expect(tracked.tracked!.nextPollAt!.getTime()).toBeGreaterThan(Date.now() + 20 * 3600_000); // back catalogue: daily
    expect(tracked.tracked?.lastError).toBeNull();

    // The spike yesterday raised one alert and an event for Inbox and agents.
    const raised = await a.as((ctx) => svc.listAlerts(ctx, { open: '1' }));
    expect(raised.map((r) => r.kind)).toEqual(['spike']);
    expect(raised[0].message).toMatch(/YouTube plays up 400%/);
    const events = await systemDb().select().from(domainEvents).where(and(eq(domainEvents.orgId, a.org.id), eq(domainEvents.type, 'streams.alert')));
    expect(events).toHaveLength(1);
    // Polling again the same day doesn't duplicate it.
    await a.as((ctx) => svc.evaluateTrackAlerts(ctx, track.id, 'youtube', 'youtube-data-api'));
    expect(await a.as((ctx) => svc.listAlerts(ctx, {}))).toHaveLength(1);

    const history = await a.as((ctx) => svc.trackHistory(ctx, track.id, {}));
    expect(history.series).toHaveLength(1);
    expect(history.series[0].points.length).toBe(10);
    const weekly = await a.as((ctx) => svc.trackHistory(ctx, track.id, { granularity: 'week' }));
    expect(weekly.series[0].points.reduce((s, p) => s + p.delta, 0)).toBe(history.series[0].points.reduce((s, p) => s + p.delta, 0));

    const m = await a.as((ctx) => svc.movers(ctx, { window: '7d' }));
    expect(m.gainers[0]).toMatchObject({ trackId: track.id, artists: ['Mara Ellis'] });
    expect(await a.as((ctx) => svc.plays28dByArtist(ctx, [artist.id]))).toEqual([{ artistId: artist.id, plays: 1_000 * 7 + 5_000 + 1_500 }]);

    const o = await a.as((ctx) => svc.overview(ctx));
    expect(o).toMatchObject({ openAlerts: 1, tracking: { tracking: 1, pendingMatch: 0, paused: 0 }, throughDay: today });
    await a.as((ctx) => svc.acknowledgeAlert(ctx, raised[0].id));
    expect((await a.as((ctx) => svc.overview(ctx))).openAlerts).toBe(0);

    // Agents see derived numbers only.
    const forAgent = await a.as((ctx) => svc.historyForAgent(ctx, { trackId: track.id, days: 30 }));
    expect(forAgent[0]).toMatchObject({ platform: 'youtube', source: 'youtube-data-api', kind: 'plays per day', last7Days: 1_000 * 5 + 5_000 + 1_500 });

    // Another label sees none of it.
    const b = await makeOrg('Other Label');
    expect(await b.as((ctx) => ctx.tx.select().from(streamDaily))).toEqual([]);
    expect(await b.as((ctx) => svc.listTracked(ctx))).toEqual([]);
  });

  it('resolves a track to its Topic art track and queues uncertain matches for review', async () => {
    const a = await makeOrg();
    const { track, st } = await a.as(async (ctx) => {
      const artist = await createArtist(ctx, { name: 'Juno Vale', status: 'active' });
      const track = await createTrack(ctx, { title: 'Night Ferries', durationMs: 198_000, artistIds: [artist.id] });
      const st = await svc.registerTrack(ctx, track.id);
      await putCredential(ctx, { provider: 'youtube', label: 'Label key', secret: { apiKey: 'test-key' } });
      return { track, st: st! };
    });
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string) => {
        const u = String(url);
        if (u.includes('/youtube/v3/search')) return json({ items: [{ id: { videoId: 'TOPIC000001' } }, { id: { videoId: 'OFFICIAL001' } }, { id: { videoId: 'COVER000001' } }] });
        if (u.includes('/youtube/v3/videos'))
          return json({
            items: [
              { id: 'TOPIC000001', snippet: { title: 'Night Ferries', channelTitle: 'Juno Vale - Topic', channelId: 'UCa', description: 'Provided to YouTube by DistroKid' }, contentDetails: { duration: 'PT3M18S' }, statistics: { viewCount: '5400' } },
              { id: 'OFFICIAL001', snippet: { title: 'Juno Vale - Night Ferries (Official Video)', channelTitle: 'Juno Vale', channelId: 'UCb', description: '' }, contentDetails: { duration: 'PT3M52S' }, statistics: { viewCount: '900' } },
              { id: 'COVER000001', snippet: { title: 'Night Ferries cover', channelTitle: 'Bedroom Covers', channelId: 'UCc', description: '' }, contentDetails: { duration: 'PT3M10S' }, statistics: { viewCount: '40' } },
            ],
          });
        throw new Error(`unexpected fetch ${u}`);
      }),
    );
    await runJob(jobs, 'streams.resolve-track', a.org.id, { streamTrackId: st.id });
    const ids = await a.as((ctx) => identitiesFor(ctx, 'track', [track.id], 'youtube'));
    expect(ids.map((i) => [i.externalId, i.variant, i.status]).sort()).toEqual([
      ['OFFICIAL001', 'official', 'pending_review'],
      ['TOPIC000001', 'topic', 'confirmed'],
    ]);
    expect((await a.as((ctx) => svc.getTracked(ctx, track.id))).tracked?.status).toBe('tracking');

    const q = await a.as((ctx) => svc.matchingQueue(ctx));
    expect(q.pending.map((p) => p.identity.externalId)).toEqual(['OFFICIAL001']);
    await a.as((ctx) => svc.reviewMatch(ctx, q.pending[0].identity.id, 'rejected'));
    expect((await a.as((ctx) => svc.matchingQueue(ctx))).pending).toEqual([]);
  });

  it('imports exact statement counts once, separate from polled data', async () => {
    const a = await makeOrg();
    const track = await a.as(async (ctx) => {
      const artist = await createArtist(ctx, { name: 'Kofi Brandt', status: 'active' });
      const track = await createTrack(ctx, { title: 'Concrete Bloom', isrc: 'DENLR2600101', artistIds: [artist.id] });
      const [doc] = await ctx.tx.insert(documents).values({ type: 'statement', title: 'Jul', extractionStatus: 'done' }).returning();
      await ctx.tx.insert(statementLines).values([
        { documentId: doc.id, periodStart: '2026-07-01', periodEnd: '2026-07-31', source: 'Spotify', isrc: 'DENLR2600101', trackId: track.id, units: 40_000, netCents: 12_000 },
        { documentId: doc.id, periodStart: '2026-07-01', periodEnd: '2026-07-31', source: 'Spotify', isrc: 'DENLR2600101', trackId: track.id, units: 2_000, netCents: 600 },
        { documentId: doc.id, periodStart: '2026-07-01', periodEnd: '2026-07-31', source: 'Apple Music', isrc: 'DENLR2600101', trackId: track.id, units: 9_000, netCents: 6_000 },
      ]);
      return { ...track, documentId: doc.id };
    });
    await runJob(jobs, 'streams.import-statement', a.org.id, { documentId: track.documentId });
    await runJob(jobs, 'streams.import-statement', a.org.id, { documentId: track.documentId });
    const rows = await a.as((ctx) => ctx.tx.select().from(streamDaily).where(eq(streamDaily.trackId, track.id)));
    expect(rows.map((r) => [r.platform, r.source, r.day, r.total]).sort()).toEqual([
      ['apple_music', 'statement-import', '2026-07-31', 9_000],
      ['spotify', 'statement-import', '2026-07-31', 42_000],
    ]);
    const snaps = await a.as((ctx) => ctx.tx.execute(`select count(*)::int as n from stream_snapshots where source = 'statement-import'` as never));
    expect((snaps as unknown as Array<{ n: number }>)[0].n).toBe(2);
    // Statement units are not plays-per-day: they stay out of 28-day totals.
    expect((await a.as((ctx) => svc.overview(ctx))).plays28d).toBe(0);
    expect((await a.as((ctx) => svc.listTracked(ctx))).map((t) => t.trackId)).toEqual([track.id]);
  });

  it('the 15-minute scheduler queues a poll for every org with tracks due, with nobody signed in', async () => {
    const a = await makeOrg();
    await a.as(async (ctx) => {
      const artist = await createArtist(ctx, { name: 'The Low Tides', status: 'active' });
      const track = await createTrack(ctx, { title: 'Undertow', artistIds: [artist.id] });
      await svc.registerTrack(ctx, track.id);
      await svc.addVideo(ctx, track.id, { video: 'CCCCCCCCCCC' });
    });
    await runJob(jobs, 'streams.schedule', null);
    const slot = Math.floor(Date.now() / (15 * 60_000));
    const job = await queue('jobs').getJob(`poll-${a.org.id}-${slot}`);
    expect(job?.name).toBe('streams.poll-org');
  });

  it('reports a missing YouTube key instead of failing, and backs off', async () => {
    const a = await makeOrg();
    const track = await a.as(async (ctx) => {
      const artist = await createArtist(ctx, { name: 'Selene Park', status: 'active' });
      const track = await createTrack(ctx, { title: 'First Light', artistIds: [artist.id] });
      await svc.registerTrack(ctx, track.id);
      await svc.addVideo(ctx, track.id, { video: 'BBBBBBBBBBB' });
      return track;
    });
    vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('no network calls expected'); }));
    await runJob(jobs, 'streams.poll-org', a.org.id);
    const [row] = await a.as((ctx) => ctx.tx.select().from(streamTracks).where(eq(streamTracks.trackId, track.id)));
    expect(row.lastError).toBe(NO_YOUTUBE_KEY);
    expect(row.nextPollAt!.getTime()).toBeGreaterThan(Date.now() + 5 * 3600_000);
    expect(await a.as((ctx) => ctx.tx.select().from(alerts))).toEqual([]);
  });
});
