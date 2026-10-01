import { afterAll, afterEach, describe, expect, it } from 'vitest';
import '../../test/modules';
import { closeDb } from '@labelconsole/core/db/client';
import { closeQueues } from '@labelconsole/core/queue';
import { closeRedis } from '@labelconsole/core/redis';
import { setSpotScraperFactory, type SpotScraperClient } from '@labelconsole/core/spotscraper';
import { FakeSpotScraper } from '../../test/fake-spotscraper';
import { makeOrg, runJob } from '../../test/helpers';
import { jobs as networkJobs } from './jobs';
import { createPlaylist, listPlaylists } from './service';

const use = (c: SpotScraperClient | null) => setSpotScraperFactory(async () => c);

afterEach(() => setSpotScraperFactory(null));
afterAll(async () => {
  await closeQueues();
  await closeDb();
  await closeRedis();
});

describe('Spotify playlists via SpotScraper', () => {
  it('fills in Spotify playlist followers', async () => {
    const a = await makeOrg('Playlist Label');
    const sp = new FakeSpotScraper();
    sp.playlists.set('37i9dQZF1DXcBWIGoYBM5M', { id: '37i9dQZF1DXcBWIGoYBM5M', name: 'Today’s Top Hits', description: null, ownerId: 'spotify', ownerName: 'Spotify', followers: 33_754_783, trackCount: 50, personalized: true });
    use(sp);
    const p = await a.as((ctx) => createPlaylist(ctx, { platform: 'spotify', name: 'Top Hits', url: 'https://open.spotify.com/playlist/37i9dQZF1DXcBWIGoYBM5M?si=x' }));
    expect(p.externalId).toBe('37i9dQZF1DXcBWIGoYBM5M');
    expect(await runJob(networkJobs, 'network.refresh-playlists', a.org.id, {})).toEqual({ playlists: 1, updated: 1 });
    const [row] = await a.as((ctx) => listPlaylists(ctx, {}));
    expect(row.playlist).toMatchObject({ name: 'Top Hits', followers: 33_754_783 });
  });
});
