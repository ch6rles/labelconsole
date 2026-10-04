import { and, eq } from 'drizzle-orm';
import { afterAll, afterEach, describe, expect, it } from 'vitest';
import '../../test/modules';
import { closeDb } from '@labelconsole/core/db/client';
import { closeQueues } from '@labelconsole/core/queue';
import { closeRedis } from '@labelconsole/core/redis';
import { setSpotScraperFactory, type SpotScraperClient } from '@labelconsole/core/spotscraper';
import { monthUsage } from '@labelconsole/core/usage';
import { createTrack, identitiesFor, upsertIdentity } from '@labelconsole/catalogue/service';
import { createArtist } from '@labelconsole/people/service';
import { FakeSpotScraper, spTrack } from '../../test/fake-spotscraper';
import { makeOrg, runJob, type TestOrg } from '../../test/helpers';
import { jobs, NO_SPOTSCRAPER_KEY } from './jobs';
import { artistSpotifyStats, streamDaily, streamTracks } from './schema';
import * as svc from './service';

const DAY = 86400_000;
const today = () => new Date().toISOString().slice(0, 10);
const use = (c: SpotScraperClient | null) => setSpotScraperFactory(async () => c);

afterEach(() => setSpotScraperFactory(null));
afterAll(async () => {
  await closeQueues();
  await closeDb();
  await closeRedis();
});

async function trackFor(a: TestOrg, isrc: string | null, artistName = 'Mara Ellis') {
  return a.as(async (ctx) => {
    const artist = await createArtist(ctx, { name: artistName, status: 'active', spotifyArtistId: 'https://open.spotify.com/artist/1dfeR4HaWDbWqFHLkxsg1d' });
    const track = await createTrack(ctx, { title: 'Tidewater', isrc, durationMs: 214_000, artistIds: [artist.id] });
    await svc.registerTrack(ctx, track.id);
    const [st] = await ctx.tx.select().from(streamTracks).where(eq(streamTracks.trackId, track.id));
    return { track, artist, st };
  });
}

describe('Spotify via SpotScraper', () => {
  it('matches a track by ISRC, polls its play count once per track and records plays per day', async () => {
    const a = await makeOrg('Spotify Label');
    const sp = new FakeSpotScraper();
    // The original release and a compilation share the ISRC (and Spotify's merged count).
    sp.tracks.set('4PTG3Z6ehGkBFwjybzWkR8', spTrack('4PTG3Z6ehGkBFwjybzWkR8', 'NLA1Z2600123', 'Mara Ellis', 70, 50_000));
    sp.tracks.set('1lO9fEwLRExY4rLtzdKaew', spTrack('1lO9fEwLRExY4rLtzdKaew', 'NLA1Z2600123', 'Various Artists', 75, 50_000));
    use(sp);
    const { track, st } = await trackFor(a, 'NLA1Z2600123');
    expect(st.status).toBe('pending_match');

    // No YouTube key: the resolver still finds the Spotify ID, and the track starts tracking.
    await runJob(jobs, 'streams.resolve-track', a.org.id, { streamTrackId: st.id });
    const d = await a.as((ctx) => svc.getTracked(ctx, track.id));
    expect(d.tracked?.status).toBe('tracking');
    expect(d.spotify.map((i) => ({ id: i.externalId, variant: i.variant, status: i.status, source: i.source }))).toEqual([{ id: '4PTG3Z6ehGkBFwjybzWkR8', variant: 'primary', status: 'confirmed', source: 'spotscraper' }]);

    // Yesterday's reading, then today's poll: the delta is plays per day, counted once.
    await a.as((ctx) => svc.recordSnapshots(ctx, [{ trackId: track.id, platform: 'spotify', source: 'spotscraper', externalId: '4PTG3Z6ehGkBFwjybzWkR8', capturedAt: new Date(Date.now() - DAY), count: 48_800 }]));
    sp.searches = [];
    await runJob(jobs, 'streams.poll-org', a.org.id);
    expect(sp.searches).toEqual([]); // already matched: no search, one track request
    const [row] = await a.as((ctx) => ctx.tx.select().from(streamDaily).where(and(eq(streamDaily.trackId, track.id), eq(streamDaily.day, today()))));
    expect(row).toMatchObject({ platform: 'spotify', source: 'spotscraper', total: 50_000, delta: 1_200 });
    expect((await a.as((ctx) => svc.getTracked(ctx, track.id))).tracked?.lastError).toBeNull();

    // The agent view reports it as its own source.
    const series = await a.as((ctx) => svc.historyForAgent(ctx, { trackId: track.id, days: 7 }));
    const spotify = series.find((s) => s.source === 'spotscraper');
    const yesterday = new Date(Date.now() - DAY).toISOString().slice(0, 10);
    expect(spotify).toMatchObject({ platform: 'spotify', total: 50_000, kind: 'plays per day', trackedSince: yesterday });
    // The first day of tracking has no plays figure, rather than a misleading 0.
    expect(spotify?.points).toEqual([
      { day: yesterday, value: null },
      { day: today(), value: 1_200 },
    ]);
    // And it isn't presented to agents as a real gain.
    expect((await a.as((ctx) => svc.movers(ctx, { window: '7d' }))).gainers[0]).toMatchObject({ trackId: track.id, current: 1_200, newlyTracked: true });

    // Requests are counted against the label's usage (SpotScraper bills per request).
    expect(await a.as((ctx) => monthUsage(ctx, 'spotscraper_requests'))).toBeGreaterThanOrEqual(2);
  });

  it('switching the Spotify ID continues the series without doubling the total or faking a spike', async () => {
    const a = await makeOrg('Switch Label');
    const sp = new FakeSpotScraper();
    sp.tracks.set('4PTG3Z6ehGkBFwjybzWkR8', spTrack('4PTG3Z6ehGkBFwjybzWkR8', 'NLA1Z2600124', 'Mara Ellis', 70, 90_000));
    use(sp);
    const { track } = await trackFor(a, 'NLA1Z2600124');
    await a.as((ctx) => svc.setSpotifyTrack(ctx, track.id, { spotify: 'https://open.spotify.com/track/27Snz8YoSOHlEOoU5gM0bc' }));
    await a.as((ctx) => svc.recordSnapshots(ctx, [{ trackId: track.id, platform: 'spotify', source: 'spotscraper', externalId: '27Snz8YoSOHlEOoU5gM0bc', capturedAt: new Date(Date.now() - DAY), count: 80_000 }]));

    // Staff point it at the original release instead.
    await a.as((ctx) => svc.setSpotifyTrack(ctx, track.id, { spotify: 'spotify:track:4PTG3Z6ehGkBFwjybzWkR8' }));
    const ids = await a.as((ctx) => identitiesFor(ctx, 'track', [track.id], 'spotify'));
    expect(ids.filter((i) => i.variant === 'primary').map((i) => i.externalId)).toEqual(['4PTG3Z6ehGkBFwjybzWkR8']);
    await runJob(jobs, 'streams.poll-org', a.org.id);
    const [row] = await a.as((ctx) => ctx.tx.select().from(streamDaily).where(and(eq(streamDaily.trackId, track.id), eq(streamDaily.day, today()))));
    expect(row).toMatchObject({ total: 90_000, delta: 0 });

    await expect(a.as((ctx) => svc.setSpotifyTrack(ctx, track.id, { spotify: 'https://open.spotify.com/album/6N9PS4QXF1D0OWPk0Sxtb4' }))).rejects.toThrow(/not a Spotify track link/);
  });

  it('promotes a Spotify ID the catalogue already knows, searches unmatched ISRCs only weekly, and says when the key is missing', async () => {
    const a = await makeOrg('Promote Label');
    const sp = new FakeSpotScraper();
    sp.tracks.set('6aiKIFjPwa3UvDCD5ecoJj', spTrack('6aiKIFjPwa3UvDCD5ecoJj', 'NLA1Z2600125', 'Mara Ellis', 30, 7_000));
    use(sp);
    const known = await trackFor(a, 'NLA1Z2600125');
    // From a metadata lookup: confirmed, but not chosen for polling.
    await a.as((ctx) => upsertIdentity(ctx, { entityType: 'track', entityId: known.track.id, platform: 'spotify', externalId: '6aiKIFjPwa3UvDCD5ecoJj', source: 'spotify', status: 'confirmed' }));
    const unknown = await trackFor(a, 'NLA1Z2600999', 'Night Ferries');

    await runJob(jobs, 'streams.resolve-track', a.org.id, { streamTrackId: known.st.id });
    await runJob(jobs, 'streams.resolve-track', a.org.id, { streamTrackId: unknown.st.id });
    expect(sp.searches).toEqual(['NLA1Z2600999']); // the known one needed no search
    expect((await a.as((ctx) => svc.getTracked(ctx, known.track.id))).spotify[0]).toMatchObject({ externalId: '6aiKIFjPwa3UvDCD5ecoJj', variant: 'primary' });
    const missing = await a.as((ctx) => svc.getTracked(ctx, unknown.track.id));
    expect(missing.tracked).toMatchObject({ status: 'pending_match', lastError: expect.stringMatching(/No Spotify track found for this ISRC/) });

    // A re-search within the week is skipped; "Search again" clears the wait.
    await runJob(jobs, 'streams.resolve-track', a.org.id, { streamTrackId: unknown.st.id });
    expect(sp.searches).toEqual(['NLA1Z2600999']);
    await a.as((ctx) => svc.requestResolve(ctx, unknown.track.id));
    await runJob(jobs, 'streams.resolve-track', a.org.id, { streamTrackId: unknown.st.id });
    expect(sp.searches).toEqual(['NLA1Z2600999', 'NLA1Z2600999']);

    // Without a key, a Spotify-only track says what's missing instead of failing silently.
    use(null);
    await runJob(jobs, 'streams.poll-org', a.org.id);
    expect((await a.as((ctx) => svc.getTracked(ctx, known.track.id))).tracked?.lastError).toBe(NO_SPOTSCRAPER_KEY);
  });

  it('reads artist audiences daily and gives agents the numbers only', async () => {
    const a = await makeOrg('Audience Label');
    const sp = new FakeSpotScraper();
    sp.artists.set('1dfeR4HaWDbWqFHLkxsg1d', { id: '1dfeR4HaWDbWqFHLkxsg1d', name: 'Mara Ellis', verified: true, genres: [], monthlyListeners: 120_000, followers: 9_000, worldRank: null, topCities: [{ city: 'Berlin', country: 'DE', listeners: 14_000 }] });
    use(sp);
    const { artist } = await trackFor(a, null);
    // A reading 28 days ago to compare with.
    await a.as((ctx) => svc.recordArtistStats(ctx, [{ artistId: artist.id, spotifyArtistId: '1dfeR4HaWDbWqFHLkxsg1d', day: new Date(Date.now() - 28 * DAY).toISOString().slice(0, 10), monthlyListeners: 100_000, followers: 8_500, worldRank: null, topCities: [], discoveredOn: [] }]));

    expect(await runJob(jobs, 'streams.audience', a.org.id)).toEqual({ artists: 1 });
    const audience = await a.as((ctx) => svc.artistAudience(ctx, artist.id));
    expect(audience).toMatchObject({ monthlyListeners: 120_000, listenersChange28d: 20_000, followersChange28d: 500, topCities: [{ city: 'Berlin' }] });
    expect(audience?.series).toHaveLength(2);

    const forAgent = await a.as((ctx) => svc.audienceForAgent(ctx, artist.id));
    expect(await a.as(async (ctx) => svc.trackArtistIds(ctx, (await ctx.tx.select().from(streamTracks))[0].trackId))).toEqual([artist.id]);
    expect(forAgent?.discoveredOnPlaylists).toEqual([
      { name: 'Late Night Indie', curator: 'Spotify', spotifyUrl: 'https://open.spotify.com/playlist/37i9dQZF1DX4UtSsGT1Sbe' },
      // Listener accounts show up as random IDs: not a curator name.
      { name: 'my mix', curator: null, spotifyUrl: 'https://open.spotify.com/playlist/0A9tWS2qryvdrFJBObAque' },
    ]);

    // A second run the same day replaces the reading instead of adding one.
    await runJob(jobs, 'streams.audience', a.org.id);
    expect(await a.as((ctx) => ctx.tx.select().from(artistSpotifyStats).where(eq(artistSpotifyStats.artistId, artist.id)))).toHaveLength(2);
  });

});
