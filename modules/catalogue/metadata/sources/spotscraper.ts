import { copyrightLines, type SpotScraperClient, type SpotifyTrack } from '@labelconsole/core/spotscraper';
import { normalizeUpc } from '../input';
import type { Query, SourceResult } from './types';

/**
 * Spotify release metadata through SpotScraper: by Spotify link, or by ISRC
 * (search) followed by the album for UPC, label, release date, the ℗ line and
 * the tracklist. Two requests per lookup. Normalised here; nothing raw is kept.
 */
export async function spotScraperLookup(client: SpotScraperClient, q: Query & { spotifyTrackId?: string | null; spotifyAlbumId?: string | null }): Promise<SourceResult | null> {
  let track: SpotifyTrack | null = null;
  if (q.spotifyTrackId) track = await client.track(q.spotifyTrackId);
  else if (q.isrc) track = (await client.searchIsrc(q.isrc))[0] ?? null; // most popular release first
  const albumId = q.spotifyAlbumId ?? track?.album?.id ?? null;
  const album = albumId ? await client.album(albumId) : null;
  if (!track && !album) return null;
  const { pLine, cLine } = copyrightLines(album?.copyright ?? track?.album?.copyright);
  const artists = track?.artists.length ? track.artists : (album?.artists ?? []);
  return {
    source: 'spotscraper',
    isrc: track?.isrc ?? null,
    title: track?.name ?? null,
    artists: artists.map((a) => a.name),
    durationMs: track?.durationMs ?? null,
    explicit: track?.explicit ?? null,
    upc: album?.upc ? normalizeUpc(album.upc) : null,
    releaseTitle: album?.name ?? track?.album?.name ?? null,
    releaseDate: album?.releaseDate ?? null,
    labelName: album?.label ?? null,
    pLine,
    cLine,
    tracks: album?.tracks.map((t, i) => ({ title: t.name, isrc: null, durationMs: t.durationMs, position: t.trackNumber ?? i + 1, explicit: null, artists: t.artists.map((a) => a.name) })),
    platformIds: [
      ...(track ? [{ platform: 'spotify', entity: 'track' as const, externalId: track.id, url: `https://open.spotify.com/track/${track.id}`, source: 'spotscraper' }] : []),
      ...(album ? [{ platform: 'spotify', entity: 'release' as const, externalId: album.id, url: `https://open.spotify.com/album/${album.id}`, source: 'spotscraper' }] : []),
    ],
  };
}
