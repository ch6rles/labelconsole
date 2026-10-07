import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { and, eq, sql } from 'drizzle-orm';
import { afterAll, afterEach, describe, expect, it, vi } from 'vitest';
import '../../test/modules';
import { closeDb, systemDb } from '@labelconsole/core/db/client';
import { closeQueues } from '@labelconsole/core/queue';
import { closeRedis } from '@labelconsole/core/redis';
import { setSpotScraperFactory } from '@labelconsole/core/spotscraper';
import { putCredential } from '@labelconsole/core/vault';
import { createTrack, identitiesFor, upsertIdentity } from '@labelconsole/catalogue/service';
import { createArtist } from '@labelconsole/people/service';
import { makeOrg, runJob, type TestOrg } from '../../test/helpers';
import { artTrackSearchesDue, jobs } from './jobs';
import { streamDaily, streamTracks } from './schema';
import { streamSnapshots } from './schema/snapshots';
import * as svc from './service';

const DAY = 86_400_000;
const today = () => new Date().toISOString().slice(0, 10);
const json = (body: unknown) => new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } });
const video = (id: string, channelTitle: string, title: string, views: number, description = '') => ({ id, snippet: { title, channelTitle, channelId: `UC${id}`, description }, contentDetails: { duration: 'PT3M18S' }, statistics: { viewCount: String(views) } });

afterEach(() => {
  vi.unstubAllGlobals();
  setSpotScraperFactory(null);
});
afterAll(async () => {
  await closeQueues();
  await closeDb();
  await closeRedis();
});

async function song(a: TestOrg, title = 'Night Ferries') {
  return a.as(async (ctx) => {
    const artist = await createArtist(ctx, { name: 'Juno Vale', status: 'active' });
    const track = await createTrack(ctx, { title, durationMs: 198_000, artistIds: [artist.id] });
    await putCredential(ctx, { provider: 'youtube', label: 'Label key', secret: { apiKey: 'test-key' } });
    return track;
  });
}
const confirm = (a: TestOrg, trackId: string, externalId: string, variant: 'topic' | 'official', status: 'confirmed' | 'rejected' = 'confirmed') =>
  a.as((ctx) => upsertIdentity(ctx, { entityType: 'track', entityId: trackId, platform: 'youtube', externalId, url: null, source: 'manual', confidence: 1, status, variant }));

describe('YouTube Music', () => {
  it('counts the art track as YouTube Music and the official video as YouTube, side by side', async () => {
    setSpotScraperFactory(async () => null);
    const a = await makeOrg('YT Music Label');
    const track = await song(a);
    await confirm(a, track.id, 'TOPIC000001', 'topic');
    await confirm(a, track.id, 'OFFICIAL001', 'official');
    await a.as(async (ctx) => {
      await svc.registerTrack(ctx, track.id);
      await svc.recordSnapshots(ctx, [
        { trackId: track.id, platform: 'youtube_music', source: 'youtube-data-api', externalId: 'TOPIC000001', capturedAt: new Date(Date.now() - DAY), count: 5_000 },
        { trackId: track.id, platform: 'youtube', source: 'youtube-data-api', externalId: 'OFFICIAL001', capturedAt: new Date(Date.now() - DAY), count: 850 },
      ]);
      await ctx.tx.update(streamTracks).set({ status: 'tracking', nextPollAt: new Date(Date.now() - 60_000) }).where(eq(streamTracks.trackId, track.id));
    });
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string) => {
        if (String(url).includes('/youtube/v3/videos')) return json({ items: [{ id: 'TOPIC000001', statistics: { viewCount: '5400' } }, { id: 'OFFICIAL001', statistics: { viewCount: '900' } }] });
        throw new Error(`unexpected fetch ${url}`);
      }),
    );
    await runJob(jobs, 'streams.poll-org', a.org.id);

    const rows = await a.as((ctx) => ctx.tx.select().from(streamDaily).where(and(eq(streamDaily.trackId, track.id), eq(streamDaily.day, today()))));
    expect(rows.map((r) => [r.platform, r.total, r.delta]).sort()).toEqual([
      ['youtube', 900, 50],
      ['youtube_music', 5_400, 400],
    ]);
    const plays = await a.as((ctx) => svc.playsByTrack(ctx, [track.id]));
    expect(plays.map((p) => [p.platform, p.total, p.plays7d]).sort()).toEqual([
      ['youtube', 900, 50],
      ['youtube_music', 5_400, 400],
    ]);
    const [listed] = await a.as((ctx) => svc.listTracked(ctx, {}));
    expect(listed).toMatchObject({ artTrack: true, videos: 2, youtubeMusic28d: 400, spotify28d: null });
  });

  it('searches a track already tracked on Spotify for its art track, never bringing back one staff rejected', async () => {
    setSpotScraperFactory(async () => null);
    const a = await makeOrg('Art Track Search Label');
    const track = await song(a);
    await a.as((ctx) => upsertIdentity(ctx, { entityType: 'track', entityId: track.id, platform: 'spotify', externalId: '4PTG3Z6ehGkBFwjybzWkR8', url: null, source: 'manual', confidence: 1, status: 'confirmed', variant: 'primary' }));
    await confirm(a, track.id, 'OFFICIAL001', 'official');
    await confirm(a, track.id, 'REJECTED001', 'topic', 'rejected');
    // Tracked through its Spotify ID, as songs synced from Spotify are.
    const st = await a.as(async (ctx) => {
      await svc.registerTrack(ctx, track.id);
      return (await ctx.tx.update(streamTracks).set({ status: 'tracking', lastResolvedAt: null }).where(eq(streamTracks.trackId, track.id)).returning())[0];
    });
    expect((await artTrackSearchesDue(50)).map((r) => r.id)).toContain(st!.id);

    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string) => {
        const u = String(url);
        if (u.includes('/youtube/v3/search')) return json({ items: ['REJECTED001', 'TOPIC000002', 'OFFICIAL002'].map((videoId) => ({ id: { videoId } })) });
        if (u.includes('/youtube/v3/videos'))
          return json({
            items: [
              video('REJECTED001', 'Juno Vale - Topic', 'Night Ferries', 9_000, 'Provided to YouTube by DistroKid'),
              video('TOPIC000002', 'Juno Vale - Topic', 'Night Ferries', 5_400, 'Provided to YouTube by DistroKid'),
              video('OFFICIAL002', 'Juno Vale', 'Juno Vale - Night Ferries (Lyric Video)', 300),
            ],
          });
        throw new Error(`unexpected fetch ${u}`);
      }),
    );
    await runJob(jobs, 'streams.resolve-track', a.org.id, { streamTrackId: st!.id });
    const ids = await a.as((ctx) => identitiesFor(ctx, 'track', [track.id], 'youtube'));
    expect(ids.map((i) => [i.externalId, i.variant, i.status]).sort()).toEqual([
      ['OFFICIAL001', 'official', 'confirmed'],
      ['REJECTED001', 'topic', 'rejected'],
      ['TOPIC000002', 'topic', 'confirmed'],
    ]);
    expect((await artTrackSearchesDue(50)).map((r) => r.id)).not.toContain(st!.id);
  });

  it('takes a pasted YouTube Music link as the art track', async () => {
    const a = await makeOrg('Pasted Link Label');
    const track = await song(a);
    await a.as((ctx) => svc.addVideo(ctx, track.id, { video: 'https://music.youtube.com/watch?v=TOPIC000003&si=abc' }));
    await a.as((ctx) => svc.addVideo(ctx, track.id, { video: 'https://www.youtube.com/watch?v=OFFICIAL003', kind: 'video' }));
    await a.as((ctx) => svc.addVideo(ctx, track.id, { video: 'https://youtu.be/TOPIC000004', kind: 'art_track' }));
    const ids = await a.as((ctx) => identitiesFor(ctx, 'track', [track.id], 'youtube'));
    expect(ids.map((i) => [i.externalId, i.variant]).sort()).toEqual([
      ['OFFICIAL003', 'official'],
      ['TOPIC000003', 'topic'],
      ['TOPIC000004', 'topic'],
    ]);
  });

  it('splits YouTube history recorded before YouTube Music had its own line, without losing a day', async () => {
    const a = await makeOrg('History Split Label');
    const track = await song(a);
    await confirm(a, track.id, 'TOPIC000005', 'topic');
    await confirm(a, track.id, 'OFFICIAL005', 'official');
    // As the tracker used to record it: both videos under "youtube", summed per day.
    for (const [n, topic, official] of [[3, 1_000, 500], [2, 1_200, 520], [1, 1_500, 560]] as Array<[number, number, number]>) {
      const capturedAt = new Date(Date.now() - n * DAY);
      await a.as((ctx) =>
        svc.recordSnapshots(ctx, [
          { trackId: track.id, platform: 'youtube', source: 'youtube-data-api', externalId: 'TOPIC000005', capturedAt, count: topic },
          { trackId: track.id, platform: 'youtube', source: 'youtube-data-api', externalId: 'OFFICIAL005', capturedAt, count: official },
        ]),
      );
    }
    const migration = readFileSync(join(__dirname, '../../packages/core/migrations/custom/003_youtube_music_split.sql'), 'utf8');
    await systemDb().execute(sql.raw(migration));
    await systemDb().execute(sql.raw(migration)); // a second run changes nothing

    const snaps = await a.as((ctx) => ctx.tx.select({ platform: streamSnapshots.platform, externalId: streamSnapshots.externalId }).from(streamSnapshots).where(eq(streamSnapshots.trackId, track.id)));
    expect(new Set(snaps.map((s) => `${s.externalId}:${s.platform}`))).toEqual(new Set(['TOPIC000005:youtube_music', 'OFFICIAL005:youtube']));
    const daily = await a.as((ctx) => ctx.tx.select().from(streamDaily).where(eq(streamDaily.trackId, track.id)).orderBy(streamDaily.platform, streamDaily.day));
    expect(daily.map((d) => [d.platform, d.total, d.delta])).toEqual([
      ['youtube', 500, 0],
      ['youtube', 520, 20],
      ['youtube', 560, 40],
      ['youtube_music', 1_000, 0],
      ['youtube_music', 1_200, 200],
      ['youtube_music', 1_500, 300],
    ]);
  });
});
