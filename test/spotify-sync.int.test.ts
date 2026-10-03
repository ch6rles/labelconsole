import { and, eq } from 'drizzle-orm';
import { afterAll, afterEach, describe, expect, it, vi } from 'vitest';
import './modules';
import { setApifyFactory } from '@labelconsole/core/apify';
import { closeDb } from '@labelconsole/core/db/client';
import { enrich } from '@labelconsole/core/modules';
import { toolByName } from '@labelconsole/core/modules';
import { logger } from '@labelconsole/core/logger';
import { closeQueues } from '@labelconsole/core/queue';
import { closeRedis } from '@labelconsole/core/redis';
import { setSpotScraperFactory } from '@labelconsole/core/spotscraper';
import type { ToolContext } from '@labelconsole/core/tools';
import { monthUsage } from '@labelconsole/core/usage';
import { jobs as catalogueJobs } from '@labelconsole/catalogue/jobs/index';
import { imports, metadataLookups, platformIdentities, releases } from '@labelconsole/catalogue/schema';
import * as catalogue from '@labelconsole/catalogue/service';
import { createArtist, getArtist } from '@labelconsole/people/service';
import { jobs as streamJobs } from '@labelconsole/streams/jobs/index';
import { artistSpotifyStats, streamTracks } from '@labelconsole/streams/schema';
import * as streams from '@labelconsole/streams/service';
import { FakeApify } from './fake-apify';
import { FakeSpotScraper } from './fake-spotscraper';
import { makeOrg, runJob, type TestOrg } from './helpers';

const ARTIST = '1dfeR4HaWDbWqFHLkxsg1d';
const ALBUM = 'A1bumTidewater00000001';
const SINGLE = 'S1ngleOtherLabel000001';
const KNOWN = 'Kn0wnRe1ease0000000001';
const T1 = 'Track0ne00000000000001';
const T2 = 'TrackTw000000000000002';

/** Deezer answers for the album's UPC (with ISRCs per track); every other public API finds nothing. */
function stubPublicApis() {
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string) => {
      const u = String(url);
      const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
      if (u.startsWith('https://api.deezer.com/album/upc:196588423017') || u.startsWith('https://api.deezer.com/album/upc:0196588423017'))
        return json({ id: 900, title: 'Tidewater', upc: '196588423017', label: 'Sync Label', release_date: '2026-03-06', record_type: 'ep', tracks: { data: [{ id: 901, title: 'Tidewater', duration: 214, artist: { name: 'Mara E.' } }, { id: 902, title: 'Low Sun', duration: 190, artist: { name: 'Mara E.' } }] } });
      if (u === 'https://api.deezer.com/track/901') return json({ id: 901, title: 'Tidewater', isrc: 'NLA1Z2600201', duration: 214 });
      if (u === 'https://api.deezer.com/track/902') return json({ id: 902, title: 'Low Sun', isrc: 'NLA1Z2600202', duration: 190 });
      if (u.startsWith('https://api.deezer.com')) return json({ error: { type: 'DataException', message: 'no data', code: 800 } });
      if (u.startsWith('https://itunes.apple.com')) return json({ resultCount: 0, results: [] });
      return json({ error: 'not found' }, 404);
    }),
  );
}

function fakeSpotify() {
  const sp = new FakeSpotScraper();
  sp.artists.set(ARTIST, { id: ARTIST, name: 'Mara E.', verified: true, genres: [], monthlyListeners: 48_200, followers: 9_100, worldRank: null, topCities: [] });
  sp.discographies.set(ARTIST, [
    { id: ALBUM, name: 'Tidewater', type: 'ep', releaseDate: '2026-03-06', trackCount: 2, imageUrl: null },
    { id: SINGLE, name: 'Before Signing', type: 'single', releaseDate: '2024-01-12', trackCount: 1, imageUrl: null },
    { id: KNOWN, name: 'Already Here', type: 'single', releaseDate: '2025-05-02', trackCount: 1, imageUrl: null },
  ]);
  sp.albums.set(ALBUM, {
    id: ALBUM,
    name: 'Tidewater',
    upc: '196588423017',
    label: 'Sync Label',
    copyright: '(P) 2026 Sync Label',
    releaseDate: '2026-03-06',
    artists: [{ id: ARTIST, name: 'Mara E.' }],
    totalTracks: 2,
    tracks: [
      { id: T1, name: 'Tidewater', durationMs: 214_000, trackNumber: 1, playCount: 120_000, artists: [{ id: ARTIST, name: 'Mara E.' }] },
      { id: T2, name: 'Low Sun', durationMs: 190_000, trackNumber: 2, playCount: 45_000, artists: [{ id: ARTIST, name: 'Mara E.' }] },
    ],
  });
  sp.albums.set(SINGLE, { id: SINGLE, name: 'Before Signing', upc: '196588423024', label: 'Other Records', copyright: '(P) 2024 Other Records', releaseDate: '2024-01-12', artists: [{ id: ARTIST, name: 'Mara E.' }], totalTracks: 1, tracks: [{ id: 'TrackOther000000000003', name: 'Before Signing', durationMs: 180_000, trackNumber: 1, playCount: 3_000, artists: [{ id: ARTIST, name: 'Mara E.' }] }] });
  setSpotScraperFactory(async () => sp);
  return sp;
}

afterEach(() => {
  vi.unstubAllGlobals();
  setSpotScraperFactory(null);
  setApifyFactory(null);
});
afterAll(async () => {
  await closeQueues();
  await closeDb();
  await closeRedis();
});

async function rosterArtist(a: TestOrg) {
  return a.as((ctx) => createArtist(ctx, { name: 'Mara Ellis', status: 'active', spotifyArtistId: `https://open.spotify.com/artist/${ARTIST}?si=x` }));
}

describe('Sync from Spotify', () => {
  it("imports an artist's new releases with ISRCs and Spotify IDs, skipping known ones and other labels' releases", async () => {
    const a = await makeOrg('Sync Label');
    const sp = fakeSpotify();
    stubPublicApis();
    const artist = await rosterArtist(a);
    // A release already in the catalogue, linked to Spotify: left alone.
    await a.as(async (ctx) => {
      const rel = await catalogue.createRelease(ctx, { title: 'Already Here', type: 'single', artistIds: [artist.id] });
      await catalogue.upsertIdentity(ctx, { entityType: 'release', entityId: rel.id, platform: 'spotify', externalId: KNOWN, source: 'manual' });
    });

    const row = await a.as((ctx) => catalogue.requestSpotifySync(ctx, artist.id, { onlyLabel: true }));
    // One sync per artist at a time.
    await expect(a.as((ctx) => catalogue.requestSpotifySync(ctx, artist.id))).rejects.toThrow(/already running/);
    await runJob(catalogueJobs, 'catalogue.spotify-sync', a.org.id, { importId: row.id });

    const done = await a.as((ctx) => catalogue.getImport(ctx, row.id));
    expect(done).toMatchObject({ status: 'done', total: 2, succeeded: 1, failed: 0, meta: { found: 3, alreadyInCatalogue: 1, skipped: 1, onlyLabel: true } });
    expect(done.items.map((i) => i.status)).toEqual(['imported', 'skipped']);
    expect(done.items[1].error).toBe('Released by Other Records');
    // The skipped release leaves no lookup behind.
    const lookups = await a.as((ctx) => ctx.tx.select().from(metadataLookups).where(eq(metadataLookups.importId, row.id)));
    expect(lookups).toHaveLength(1);

    const release = await a.as((ctx) => catalogue.getRelease(ctx, done.items[0].releaseId!));
    expect(release.release).toMatchObject({ title: 'Tidewater', upc: '0196588423017', labelName: 'Sync Label', releaseDate: '2026-03-06', status: 'live' });
    expect(release.artists.map((x) => x.id)).toEqual([artist.id]);
    expect(release.tracks.map((t) => [t.position, t.title, t.isrc])).toEqual([
      [1, 'Tidewater', 'NLA1Z2600201'],
      [2, 'Low Sun', 'NLA1Z2600202'],
    ]);
    // Credits under the Spotify name land on the roster artist, which now has it as an alias.
    expect((await a.as((ctx) => getArtist(ctx, artist.id))).aliases).toContain('Mara E.');

    // Each track carries its Spotify ID as the one Streams polls, so tracking starts without a search.
    const trackIds = release.tracks.map((t) => t.id);
    const ids = await a.as((ctx) => catalogue.identitiesFor(ctx, 'track', trackIds, 'spotify'));
    expect(ids.map((i) => [i.externalId, i.variant, i.status]).sort()).toEqual([
      [T1, 'primary', 'confirmed'],
      [T2, 'primary', 'confirmed'],
    ]);
    const st = await a.as(async (ctx) => {
      for (const id of trackIds) await streams.registerTrack(ctx, id);
      return ctx.tx.select().from(streamTracks).where(eq(streamTracks.trackId, trackIds[0]));
    });
    expect(st[0].status).toBe('tracking');
    expect(await a.as((ctx) => monthUsage(ctx, 'spotscraper_requests'))).toBeGreaterThanOrEqual(4);

    // Syncing again finds nothing new to import.
    sp.requests = 0;
    const again = await a.as((ctx) => catalogue.requestSpotifySync(ctx, artist.id));
    await runJob(catalogueJobs, 'catalogue.spotify-sync', a.org.id, { importId: again.id });
    const second = await a.as((ctx) => catalogue.getImport(ctx, again.id));
    expect(second).toMatchObject({ status: 'done', total: 1, meta: { alreadyInCatalogue: 2 } }); // only the other label's single is new
    const rels = await a.as((ctx) => ctx.tx.select().from(releases));
    expect(rels.map((r) => r.title).sort()).toEqual(['Already Here', 'Before Signing', 'Tidewater']); // without onlyLabel it comes in
  });

  it('explains what is missing before starting, and fails cleanly for an unknown Spotify artist', async () => {
    const a = await makeOrg('Sync Errors Label');
    const plain = await a.as((ctx) => createArtist(ctx, { name: 'No Link', status: 'active' }));
    setSpotScraperFactory(async () => new FakeSpotScraper());
    await expect(a.as((ctx) => catalogue.requestSpotifySync(ctx, plain.id))).rejects.toThrow(/Spotify artist link/);
    const artist = await rosterArtist(a);
    setSpotScraperFactory(async () => null);
    await expect(a.as((ctx) => catalogue.requestSpotifySync(ctx, artist.id))).rejects.toThrow(/SpotScraper key/);
    setSpotScraperFactory(async () => new FakeSpotScraper());
    const row = await a.as((ctx) => catalogue.requestSpotifySync(ctx, artist.id));
    await runJob(catalogueJobs, 'catalogue.spotify-sync', a.org.id, { importId: row.id });
    expect(await a.as((ctx) => catalogue.getImport(ctx, row.id))).toMatchObject({ status: 'failed', meta: { error: 'Spotify has no artist with that ID' } });
    const latest = await a.as((ctx) => catalogue.latestSpotifySync(ctx, artist.id));
    expect(latest?.id).toBe(row.id);
    const all = await a.as((ctx) => ctx.tx.select().from(imports).where(and(eq(imports.kind, 'spotify'))));
    expect(all).toHaveLength(1);
  });
});

describe('Spotify numbers in lists', () => {
  it("reads a new artist's audience straight away and shows monthly listeners and track plays", async () => {
    const a = await makeOrg('Numbers Label');
    fakeSpotify();
    const artist = await rosterArtist(a);
    await runJob(streamJobs, 'streams.audience', a.org.id, { artistIds: [artist.id] });
    const stats = await a.as((ctx) => ctx.tx.select().from(artistSpotifyStats).where(eq(artistSpotifyStats.artistId, artist.id)));
    expect(stats.map((s) => s.monthlyListeners)).toEqual([48_200]);
    const enabled = new Set(['people', 'catalogue', 'streams']);
    const artistExtras = await a.as((ctx) => enrich(ctx, enabled, 'artist', [artist.id]));
    expect(artistExtras[artist.id]).toMatchObject({ monthlyListeners: 48_200 });

    const track = await a.as((ctx) => catalogue.createTrack(ctx, { title: 'Tidewater', artistIds: [artist.id] }));
    const yesterday = new Date(Date.now() - 86400_000);
    await a.as((ctx) =>
      streams.recordSnapshots(ctx, [
        { trackId: track.id, platform: 'spotify', source: 'spotscraper', externalId: T1, capturedAt: new Date(yesterday.getTime() - 86400_000), count: 100_000 },
        { trackId: track.id, platform: 'spotify', source: 'spotscraper', externalId: T1, capturedAt: yesterday, count: 104_000 },
        { trackId: track.id, platform: 'spotify', source: 'spotscraper', externalId: T1, capturedAt: new Date(), count: 109_500 },
      ]),
    );
    const trackExtras = await a.as((ctx) => enrich(ctx, enabled, 'track', [track.id]));
    expect(trackExtras[track.id]).toEqual({ spotifyPlays: 109_500, spotifyPlays7d: 9_500 });
  });
});

/** Call a tool the way the runtime does, as the label's owner. */
const toolCtx = (a: TestOrg): ToolContext => ({ orgId: a.org.id, agentId: 'test', runId: 'test', stepId: '', idempotencyKey: 'k', signal: new AbortController().signal, log: logger, withOrg: (fn) => a.as(fn), credential: async () => null });
async function callTool<T = Record<string, any>>(a: TestOrg, name: string, input: unknown): Promise<T> {
  const tool = toolByName(name)!;
  return (await tool.execute(toolCtx(a), tool.input.parse(input))) as T;
}

describe('Spotify agent tools', () => {
  it('looks up tracks, releases, playlists and discographies, marking what is in the catalogue', async () => {
    const a = await makeOrg('Tools Label');
    const sp = fakeSpotify();
    const artist = await rosterArtist(a);
    const track = await a.as(async (ctx) => {
      const t = await catalogue.createTrack(ctx, { title: 'Tidewater', isrc: 'NLA1Z2600201', artistIds: [artist.id] });
      await catalogue.upsertIdentity(ctx, { entityType: 'track', entityId: t.id, platform: 'spotify', externalId: T1, source: 'manual', variant: 'primary' });
      return t;
    });
    sp.tracks.set(T1, { id: T1, name: 'Tidewater', isrc: null, durationMs: 214_000, explicit: false, popularity: 51, playCount: 120_000, artists: [{ id: ARTIST, name: 'Mara E.' }], album: { id: ALBUM, name: 'Tidewater', copyright: null } });
    sp.playlists.set('Play1istFunk0000000001', { id: 'Play1istFunk0000000001', name: 'Funk Nights', description: 'slowed funk', ownerId: 'curator', ownerName: 'A Curator', followers: 18_400, trackCount: 2, personalized: false });
    sp.playlistItems.set('Play1istFunk0000000001', [
      { id: 'SomeoneElse00000000001', name: 'Montagem', position: 1, addedAt: '2026-09-01T00:00:00Z', playCount: 2_000_000, durationMs: 100_000, artists: [{ id: 'X'.repeat(22), name: 'ZAYLO' }], album: null },
      { id: T1, name: 'Tidewater', position: 2, addedAt: '2026-09-20T00:00:00Z', playCount: 120_000, durationMs: 214_000, artists: [{ id: ARTIST, name: 'Mara E.' }], album: { id: ALBUM, name: 'Tidewater' } },
    ]);

    const t = await callTool(a, 'spotify_track_lookup', { track: `https://open.spotify.com/track/${T1}` });
    expect(t).toMatchObject({ name: 'Tidewater', playCount: 120_000, inCatalogue: { id: track.id, title: 'Tidewater' } });
    expect(await callTool(a, 'spotify_track_lookup', { track: 'not a track' })).toEqual({ error: 'Give a Spotify track link or an ISRC' });

    const p = await callTool(a, 'spotify_playlist_lookup', { playlist: 'spotify:playlist:Play1istFunk0000000001', tracks: 1 });
    expect(p).toMatchObject({ name: 'Funk Nights', curator: 'A Curator', followers: 18_400 });
    expect(p.tracks).toHaveLength(1);
    expect(p.labelTracks).toEqual([{ position: 2, name: 'Tidewater', artists: ['Mara E.'], playCount: 120_000, addedAt: '2026-09-20', catalogueTrack: { id: track.id, title: 'Tidewater' } }]);

    const al = await callTool(a, 'spotify_album_lookup', { album: ALBUM });
    expect(al).toMatchObject({ upc: '196588423017', label: 'Sync Label', inCatalogue: null });
    expect(al.tracks.map((x: { playCount: number }) => x.playCount)).toEqual([120_000, 45_000]);

    const d = await callTool(a, 'spotify_artist_discography', { artist: `https://open.spotify.com/artist/${ARTIST}` });
    expect(d).toMatchObject({ total: 3, inCatalogue: 0 });
    expect(d.releases[0]).toMatchObject({ name: 'Tidewater', type: 'ep' });
    expect(await a.as((ctx) => monthUsage(ctx, 'spotscraper_requests'))).toBeGreaterThanOrEqual(5);

    setSpotScraperFactory(async () => null);
    expect(await callTool(a, 'spotify_album_lookup', { album: ALBUM })).toEqual({ error: expect.stringMatching(/No SpotScraper key/) });
  });

  it('searches Spotify through Apify and fills in the numbers from SpotScraper', async () => {
    const a = await makeOrg('Search Label');
    const sp = fakeSpotify();
    sp.playlists.set('Play1istFunk0000000001', { id: 'Play1istFunk0000000001', name: 'Funk Nights', description: 'slowed funk', ownerId: 'curator', ownerName: 'A Curator', followers: 18_400, trackCount: 41, personalized: false });
    const apify = new FakeApify();
    apify.answers.set('automation-lab/spotify-scraper', [
      { type: 'playlist', id: 'Play1istFunk0000000001', name: 'Funk Nights', owner: '', description: 'slowed funk', url: 'https://open.spotify.com/playlist/Play1istFunk0000000001', followers: null },
      { type: 'playlist', id: 'bad id' },
    ]);
    setApifyFactory(async () => apify);
    const r = await callTool(a, 'spotify_search', { query: 'funk edit', type: 'playlists', limit: 5 });
    expect(apify.runs[0]).toMatchObject({ actor: 'automation-lab/spotify-scraper', input: { mode: 'search', searchTerms: ['funk edit'], searchType: 'playlists', maxResults: 5 }, maxItems: 5 });
    expect(r.results).toEqual([{ name: 'Funk Nights', url: 'https://open.spotify.com/playlist/Play1istFunk0000000001', curator: 'A Curator', followers: 18_400, trackCount: 41, description: 'slowed funk' }]);
    expect(await a.as((ctx) => monthUsage(ctx, 'apify_results'))).toBe(2);
  });
});
