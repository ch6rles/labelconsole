import type { SpotScraperClient } from '@labelconsole/core/spotscraper';
import type { Snapshot, StreamSourceAdapter, TrackArtistRefs, TrackRef } from './types';

/**
 * Spotify play counts through SpotScraper: one request per track, the
 * all-time count Spotify shows on the track page. Polled like YouTube views,
 * so the daily change is plays per day.
 *
 * A track is polled through exactly one Spotify ID (its primary identity).
 * Re-releases and compilations carry the same ISRC and usually show the same
 * merged count, so polling several IDs would count the same plays twice.
 */
const CONCURRENCY = 4;

export const spotifyAdapter: StreamSourceAdapter<SpotScraperClient> = {
  id: 'spotscraper',
  async fetch(client, refs, opts) {
    const sp = refs.filter((r) => r.platform === 'spotify');
    const snapshots: Snapshot[] = [];
    const missing: TrackRef[] = [];
    // Each read also names the track's Spotify artists, which links roster artists to their profiles at no extra cost.
    const artists: TrackArtistRefs[] = [];
    const capturedAt = new Date();
    let next = 0;
    const worker = async () => {
      while (next < sp.length) {
        const r = sp[next++];
        const t = await client.track(r.externalId, opts?.signal);
        if (t?.artists.length) artists.push({ trackId: r.trackId, artists: t.artists });
        // A track that disappeared or hides its count is reported, never recorded as zero.
        if (t?.playCount == null) missing.push(r);
        else snapshots.push({ trackId: r.trackId, platform: 'spotify', source: 'spotscraper', externalId: r.externalId, capturedAt, count: t.playCount });
      }
    };
    await Promise.all(Array.from({ length: Math.min(CONCURRENCY, sp.length) }, worker));
    return { snapshots, missing, artists };
  },
};
