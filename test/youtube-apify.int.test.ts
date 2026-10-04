import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { eq } from 'drizzle-orm';
import { afterAll, afterEach, describe, expect, it } from 'vitest';
import './modules';
import { setApifyFactory } from '@labelconsole/core/apify';
import { closeDb } from '@labelconsole/core/db/client';
import { closeQueues } from '@labelconsole/core/queue';
import { closeRedis } from '@labelconsole/core/redis';
import { setSpotScraperFactory } from '@labelconsole/core/spotscraper';
import { monthUsage } from '@labelconsole/core/usage';
import { createTrack, identitiesFor } from '@labelconsole/catalogue/service';
import { createArtist } from '@labelconsole/people/service';
import { jobs, NO_YOUTUBE_KEY } from '@labelconsole/streams/jobs/index';
import { streamDaily, streamTracks } from '@labelconsole/streams/schema';
import * as streams from '@labelconsole/streams/service';
import { FakeApify } from './fake-apify';
import { makeOrg, runJob, type TestOrg } from './helpers';

/** A live apidojo/youtube-scraper search for the song, descriptions trimmed. */
const SEARCH = JSON.parse(readFileSync(join(__dirname, '../modules/streams/sources/__fixtures__/youtube-apify-search.json'), 'utf8')) as unknown[];
const ACTOR = 'apidojo/youtube-scraper';

afterEach(() => {
  setApifyFactory(null);
  setSpotScraperFactory(null);
});
afterAll(async () => {
  await closeQueues();
  await closeDb();
  await closeRedis();
});

async function song(a: TestOrg) {
  return a.as(async (ctx) => {
    const artist = await createArtist(ctx, { name: 'Rick Astley', status: 'active' });
    const track = await createTrack(ctx, { title: 'Never Gonna Give You Up', durationMs: 213_573, artistIds: [artist.id] });
    await streams.registerTrack(ctx, track.id);
    const [st] = await ctx.tx.select().from(streamTracks).where(eq(streamTracks.trackId, track.id));
    return { track, st };
  });
}

describe('YouTube views without a Data API key', () => {
  it('matches the art track and reads its views through Apify, once a day', async () => {
    const a = await makeOrg('YouTube Apify Label');
    setSpotScraperFactory(async () => null);
    const apify = new FakeApify();
    let views = 12_947_987;
    apify.respond = (actor, input) => {
      if (actor !== ACTOR) return undefined;
      if (input.keywords) return SEARCH;
      return (input.startUrls as string[]).map((u) => ({ type: 'video', id: u.slice(-11), views: views, status: 'OK' }));
    };
    setApifyFactory(async () => apify);
    const { track, st } = await song(a);

    await runJob(jobs, 'streams.resolve-track', a.org.id, { streamTrackId: st.id });
    expect(apify.runs[0]).toMatchObject({ actor: ACTOR, input: { keywords: ['Rick Astley Never Gonna Give You Up'], maxItems: 10 } });
    const ids = await a.as((ctx) => identitiesFor(ctx, 'track', [track.id], 'youtube'));
    // The art track (what YouTube Music plays) is confirmed; the official video waits for review.
    expect(ids.map((i) => [i.externalId, i.variant, i.status, i.source]).sort()).toEqual([
      ['3BFTio5296w', 'topic', 'confirmed', 'youtube-scraper-search'],
      ['dQw4w9WgXcQ', 'official', 'pending_review', 'youtube-scraper-search'],
    ]);
    const tracked = await a.as((ctx) => streams.getTracked(ctx, track.id));
    expect(tracked.tracked?.status).toBe('tracking');

    await runJob(jobs, 'streams.poll-org', a.org.id);
    expect(apify.runs[1]).toMatchObject({ actor: ACTOR, input: { startUrls: ['https://www.youtube.com/watch?v=3BFTio5296w'], maxItems: 1 } });
    const day = await a.as((ctx) => ctx.tx.select().from(streamDaily).where(eq(streamDaily.trackId, track.id)));
    expect(day.map((d) => [d.platform, d.source, d.total])).toEqual([['youtube', 'youtube-scraper', 12_947_987]]);
    expect(await a.as((ctx) => monthUsage(ctx, 'apify_results'))).toBe(6); // 5 search results + 1 video

    // Due again the same day: already read today, so nothing is paid for twice.
    views += 5_000;
    await a.as((ctx) => ctx.tx.update(streamTracks).set({ nextPollAt: new Date(Date.now() - 1000) }).where(eq(streamTracks.id, st.id)));
    await runJob(jobs, 'streams.poll-org', a.org.id);
    expect(apify.runs).toHaveLength(2);
    expect((await a.as((ctx) => streams.getTracked(ctx, track.id))).tracked?.lastError).toBeNull();
  });

  it('asks for a key or a token when there is neither, and reports a failed Apify read without retrying', async () => {
    const a = await makeOrg('YouTube None Label');
    setSpotScraperFactory(async () => null);
    setApifyFactory(async () => null);
    const { st } = await song(a);
    await runJob(jobs, 'streams.resolve-track', a.org.id, { streamTrackId: st.id });
    let row = (await a.as((ctx) => ctx.tx.select().from(streamTracks).where(eq(streamTracks.id, st.id))))[0];
    expect(row).toMatchObject({ status: 'pending_match', lastError: NO_YOUTUBE_KEY });
    expect(NO_YOUTUBE_KEY).toMatch(/YouTube Data API key \(free\) or an Apify token/);

    const apify = new FakeApify();
    apify.failWith = new Error('Apify refused the API token');
    setApifyFactory(async () => apify);
    await runJob(jobs, 'streams.resolve-track', a.org.id, { streamTrackId: st.id });
    row = (await a.as((ctx) => ctx.tx.select().from(streamTracks).where(eq(streamTracks.id, st.id))))[0];
    expect(row.lastError).toBe('YouTube search (Apify): Apify refused the API token');
    expect(apify.runs).toHaveLength(1);
  });
});
