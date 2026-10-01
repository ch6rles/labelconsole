import { afterAll, afterEach, describe, expect, it } from 'vitest';
import '../../test/modules';
import { closeDb } from '@labelconsole/core/db/client';
import { closeQueues } from '@labelconsole/core/queue';
import { closeRedis } from '@labelconsole/core/redis';
import { setSpotScraperFactory, type SpotScraperClient } from '@labelconsole/core/spotscraper';
import { createArtist } from '@labelconsole/people/service';
import { FakeSpotScraper, spTrack } from '../../test/fake-spotscraper';
import { makeOrg, runJob, type TestOrg } from '../../test/helpers';
import { jobs } from './jobs';
import { createTrack, getTrack, identitiesFor } from './service';

const use = (c: SpotScraperClient | null) => setSpotScraperFactory(async () => c);

afterEach(() => setSpotScraperFactory(null));
afterAll(async () => {
  await closeQueues();
  await closeDb();
  await closeRedis();
});

async function trackFor(a: TestOrg, isrc: string | null) {
  return a.as(async (ctx) => {
    const artist = await createArtist(ctx, { name: 'Mara Ellis', aliases: ['M. Ellis'], status: 'active' });
    const track = await createTrack(ctx, { title: 'Tidewater', isrc, durationMs: 214_000, artistIds: [artist.id] });
    return { track, artist };
  });
}

describe('Spotify credits via SpotScraper', () => {
  it('imports Spotify credits without duplicates, linking roster artists', async () => {
    const a = await makeOrg('Credits Label');
    const sp = new FakeSpotScraper();
    sp.tracks.set('4PTG3Z6ehGkBFwjybzWkR8', spTrack('4PTG3Z6ehGkBFwjybzWkR8', 'NLA1Z2600126', 'Mara Ellis', 70, 1));
    sp.credit.set('4PTG3Z6ehGkBFwjybzWkR8', [
      { name: 'Mara Ellis', role: 'Main Artist' },
      { name: 'Jonas Field', role: 'Producer' },
      { name: 'Mara Ellis', role: 'Composer' },
    ]);
    use(sp);
    const { track, artist } = await trackFor(a, 'NLA1Z2600126');
    expect((await a.as((ctx) => getTrack(ctx, track.id))).track.blockers).toContain('No credits');

    expect(await runJob(jobs, 'catalogue.import-credits', a.org.id, { trackIds: [track.id] })).toMatchObject({ matched: 1, added: 3 });
    const t = await a.as((ctx) => getTrack(ctx, track.id));
    expect(t.credits.map((c) => `${c.role}: ${c.name}`).sort()).toEqual(['Composer: Mara Ellis', 'Main Artist: Mara Ellis', 'Producer: Jonas Field']);
    expect(t.credits.filter((c) => c.name === 'Mara Ellis').every((c) => c.artistId === artist.id)).toBe(true);
    expect(t.track.blockers).not.toContain('No credits');

    // Again: nothing new. The bulk form (no track IDs) finds only tracks without credits.
    expect(await runJob(jobs, 'catalogue.import-credits', a.org.id, { trackIds: [track.id] })).toMatchObject({ added: 0 });
    expect(await runJob(jobs, 'catalogue.import-credits', a.org.id, { trackIds: null })).toMatchObject({ tracks: 0 });
  });


  it('finds the Spotify ID by ISRC when the track has none, and keeps it for Streams', async () => {
    const a = await makeOrg('Credits Search Label');
    const sp = new FakeSpotScraper();
    sp.tracks.set('4PTG3Z6ehGkBFwjybzWkR8', spTrack('4PTG3Z6ehGkBFwjybzWkR8', 'NLA1Z2600127', 'Mara Ellis', 70, 1));
    sp.credit.set('4PTG3Z6ehGkBFwjybzWkR8', [{ name: 'M. Ellis', role: 'Lyricist' }]);
    use(sp);
    const { track, artist } = await trackFor(a, 'NLA1Z2600127');
    expect(await runJob(jobs, 'catalogue.import-credits', a.org.id, { trackIds: null })).toMatchObject({ tracks: 1, matched: 1, added: 1 });
    expect(sp.searches).toEqual(['NLA1Z2600127']);
    const ids = await a.as((ctx) => identitiesFor(ctx, 'track', [track.id], 'spotify'));
    expect(ids).toMatchObject([{ externalId: '4PTG3Z6ehGkBFwjybzWkR8', status: 'confirmed', source: 'spotscraper' }]);
    // Matched by alias.
    expect((await a.as((ctx) => getTrack(ctx, track.id))).credits[0]).toMatchObject({ name: 'M. Ellis', artistId: artist.id });
  });
});
