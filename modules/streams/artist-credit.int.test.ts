import { eq } from 'drizzle-orm';
import { afterAll, afterEach, describe, expect, it } from 'vitest';
import '../../test/modules';
import { closeDb } from '@labelconsole/core/db/client';
import { closeQueues } from '@labelconsole/core/queue';
import { closeRedis } from '@labelconsole/core/redis';
import { setSpotScraperFactory, type SpotScraperClient } from '@labelconsole/core/spotscraper';
import { monthUsage } from '@labelconsole/core/usage';
import { addTrackArtists, artistsOnTrack, createRelease, createTrack, linkTrack, upsertIdentity } from '@labelconsole/catalogue/service';
import { trackArtists } from '@labelconsole/catalogue/schema';
import { createArtist, getArtist, updateArtist } from '@labelconsole/people/service';
import { FakeSpotScraper } from '../../test/fake-spotscraper';
import { makeOrg, runJob, type TestOrg } from '../../test/helpers';
import { jobs } from './jobs';
import { streamTracks } from './schema';
import * as svc from './service';

const DAY = 86400_000;
const use = (c: SpotScraperClient | null) => setSpotScraperFactory(async () => c);
const SYX = '2syxxsecArtistIdAbcdef';
const VEX = '3vexsynArtistIdAbcdefg';

afterEach(() => setSpotScraperFactory(null));
afterAll(async () => {
  await closeQueues();
  await closeDb();
  await closeRedis();
});

/** Two days of Spotify readings for a track: yesterday's total, then today's. */
async function plays(a: TestOrg, trackId: string, before: number, after: number) {
  await a.as((ctx) =>
    svc.recordSnapshots(ctx, [
      { trackId, platform: 'spotify', source: 'spotscraper', externalId: null, capturedAt: new Date(Date.now() - DAY), count: before },
      { trackId, platform: 'spotify', source: 'spotscraper', externalId: null, capturedAt: new Date(), count: after },
    ]),
  );
}

describe('Plays credited to every artist on a track', () => {
  it('counts a collaboration for both artists, and a release credit for the release’s artists', async () => {
    const a = await makeOrg('Credit Label');
    const { syx, vex, guest, collab, solo } = await a.as(async (ctx) => {
      const syx = await createArtist(ctx, { name: 'syxxsec', status: 'active' });
      const vex = await createArtist(ctx, { name: 'vexsyn', status: 'active' });
      const guest = await createArtist(ctx, { name: 'Guest', status: 'prospect' });
      // Imported from Spotify, the second artist on a track is saved as featured.
      const collab = await createTrack(ctx, { title: 'Ainsi Bas La Vida Hardtekk', isrc: 'QZTB52600001', artistIds: [syx.id, vex.id] });
      // A track credited to one artist, on a release credited to two.
      const solo = await createTrack(ctx, { title: 'Solo Cut', isrc: 'QZTB52600002', artistIds: [syx.id] });
      const release = await createRelease(ctx, { title: 'Split EP', type: 'ep', artistIds: [syx.id, guest.id] });
      await linkTrack(ctx, release.id, solo.id);
      for (const t of [collab, solo]) await svc.registerTrack(ctx, t.id);
      return { syx, vex, guest, collab, solo };
    });
    await plays(a, collab.id, 10_000, 14_000);
    await plays(a, solo.id, 2_000, 2_500);

    const byArtist = Object.fromEntries((await a.as((ctx) => svc.plays28dByArtist(ctx, [syx.id, vex.id, guest.id]))).map((r) => [r.artistId, r.plays]));
    expect(byArtist).toEqual({ [syx.id]: 4_500, [vex.id]: 4_000, [guest.id]: 500 });

    // The featured artist's own page shows the plays and the track.
    const h = await a.as((ctx) => svc.artistHistory(ctx, vex.id, { from: new Date(Date.now() - 7 * DAY).toISOString().slice(0, 10) }));
    expect(h.series.find((s) => s.platform === 'spotify')?.points.at(-1)).toMatchObject({ total: 14_000, delta: 4_000 });
    expect(h.topTracks).toEqual([{ trackId: collab.id, title: 'Ainsi Bas La Vida Hardtekk', plays: 4_000 }]);

    // Lists name every artist on the track, the lead artist first.
    const listed = await a.as((ctx) => svc.listTracked(ctx, {}));
    expect(listed.find((t) => t.trackId === collab.id)?.artists).toEqual(['syxxsec', 'vexsyn']);
    expect(await a.as((ctx) => svc.trackArtistIds(ctx, solo.id))).toEqual([syx.id, guest.id]);
  });

  it('adds a missing collaborator to a track without changing who leads it', async () => {
    const a = await makeOrg('Merge Label');
    await a.as(async (ctx) => {
      const lead = await createArtist(ctx, { name: 'Lead', status: 'active' });
      const other = await createArtist(ctx, { name: 'Other', status: 'active' });
      const t = await createTrack(ctx, { title: 'Shared', artistIds: [lead.id] });
      await addTrackArtists(ctx, t.id, [other.id, lead.id, other.id]);
      const rows = await ctx.tx.select({ artistId: trackArtists.artistId, role: trackArtists.role }).from(trackArtists).where(eq(trackArtists.trackId, t.id));
      expect(rows.sort((x, y) => x.role.localeCompare(y.role))).toEqual([
        { artistId: other.id, role: 'featured' },
        { artistId: lead.id, role: 'primary' },
      ]);
      expect((await artistsOnTrack(ctx, [t.id])).get(t.id)?.map((x) => x.name)).toEqual(['Lead', 'Other']);
    });
  });
});

describe('Linking artists to their Spotify profiles', () => {
  it('stores the ID from a pasted profile link and refuses links that are not artist profiles', async () => {
    const a = await makeOrg('Profile Link Label');
    await a.as(async (ctx) => {
      const artist = await createArtist(ctx, { name: 'Linkable', status: 'active', spotifyArtistId: `https://open.spotify.com/intl-de/artist/${SYX}?si=0123456789abcdef0123456789` });
      expect(artist.spotifyArtistId).toBe(SYX);
      await expect(updateArtist(ctx, artist.id, { spotifyArtistId: 'https://open.spotify.com/track/4PTG3Z6ehGkBFwjybzWkR8' })).rejects.toThrow(/Spotify profile link/);
      expect((await updateArtist(ctx, artist.id, { spotifyArtistId: '' })).spotifyArtistId).toBeNull();
    });
  });

  it('links artists from the Spotify artists on the tracks it polls, leaving ambiguous and taken profiles alone', async () => {
    const a = await makeOrg('Auto Link Label');
    const sp = new FakeSpotScraper();
    sp.tracks.set('4PTG3Z6ehGkBFwjybzWkR8', {
      id: '4PTG3Z6ehGkBFwjybzWkR8',
      name: 'Ainsi Bas La Vida Hardtekk',
      isrc: 'QZTB52600001',
      durationMs: 180_000,
      explicit: false,
      popularity: 40,
      playCount: 48_800,
      artists: [
        { id: SYX, name: 'syxxsec' },
        { id: VEX, name: 'VEXSYN' },
        { id: '4novaOneArtistIdAbcdef', name: 'Nova' },
        { id: '5novaTwoArtistIdAbcdef', name: 'Nova' },
        { id: '6heldArtistIdAbcdefghi', name: 'Held' },
      ],
      album: null,
    });
    use(sp);
    const { syx, vex, nova, held, track } = await a.as(async (ctx) => {
      const syx = await createArtist(ctx, { name: 'syxxsec', status: 'active' });
      const vex = await createArtist(ctx, { name: 'vexsyn', status: 'active' });
      const nova = await createArtist(ctx, { name: 'Nova', status: 'active' });
      const held = await createArtist(ctx, { name: 'Held', status: 'active' });
      // Another roster artist already holds the profile named "Held".
      await createArtist(ctx, { name: 'Held (old entry)', status: 'alumni', spotifyArtistId: '6heldArtistIdAbcdefghi' });
      const track = await createTrack(ctx, { title: 'Ainsi Bas La Vida Hardtekk', isrc: 'QZTB52600001', artistIds: [syx.id, vex.id, nova.id, held.id] });
      await upsertIdentity(ctx, { entityType: 'track', entityId: track.id, platform: 'spotify', externalId: '4PTG3Z6ehGkBFwjybzWkR8', url: null, source: 'release-tracklist', confidence: 1, status: 'confirmed', variant: 'primary' });
      await svc.registerTrack(ctx, track.id);
      return { syx, vex, nova, held, track };
    });
    await a.as((ctx) => ctx.tx.update(streamTracks).set({ status: 'tracking', nextPollAt: new Date(Date.now() - 60_000) }).where(eq(streamTracks.trackId, track.id)));

    await runJob(jobs, 'streams.poll-org', a.org.id);
    const after = await a.as(async (ctx) => Promise.all([syx, vex, nova, held].map((x) => getArtist(ctx, x.id))));
    expect(after.map((x) => x.spotifyArtistId)).toEqual([SYX, VEX, null, null]);
    // One request, the poll's own read: linking costs nothing extra.
    expect(await a.as((ctx) => monthUsage(ctx, 'spotscraper_requests'))).toBe(1);
  });

  it('finds a profile on request through an ISRC search when no Spotify ID is known yet', async () => {
    const a = await makeOrg('Find Label');
    const sp = new FakeSpotScraper();
    sp.tracks.set('7findTrackIdAbcdefghij', { id: '7findTrackIdAbcdefghij', name: 'Night Drive', isrc: 'QZTB52600009', durationMs: 200_000, explicit: false, popularity: 30, playCount: 1_000, artists: [{ id: VEX, name: 'vexsyn' }], album: null });
    use(sp);
    const vex = await a.as(async (ctx) => {
      const vex = await createArtist(ctx, { name: 'vexsyn', status: 'active' });
      const other = await createArtist(ctx, { name: 'Unreleased', status: 'prospect' });
      await createTrack(ctx, { title: 'Night Drive', isrc: 'QZTB52600009', artistIds: [vex.id] });
      expect((await svc.spotifyLinkState(ctx, other.id)).spotifyTracks).toBe(0);
      expect(await svc.spotifyLinkState(ctx, vex.id)).toEqual({ linked: false, spotScraper: true, spotifyTracks: 1 });
      return vex;
    });

    expect(await runJob(jobs, 'streams.link-artists', a.org.id, {})).toEqual({ looked: 1, linked: 1 });
    expect(sp.searches).toEqual(['QZTB52600009']);
    expect((await a.as((ctx) => getArtist(ctx, vex.id))).spotifyArtistId).toBe(VEX);
    // Linked artists drop out of the next run.
    expect(await runJob(jobs, 'streams.link-artists', a.org.id, {})).toEqual({ looked: 0, linked: 0 });
    expect(await a.as((ctx) => svc.spotifyLinkState(ctx, vex.id))).toMatchObject({ linked: true });
  });
});
