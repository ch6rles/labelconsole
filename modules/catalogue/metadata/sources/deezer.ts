import { fetchJson } from '@labelconsole/core/http';
import { normalizeUpc } from '../input';
import type { Query, SourceResult, SourceTrack } from './types';
import { normType } from './types';

/** Deezer public API: no auth, ~50 requests per 5 seconds. */
const RL = { key: 'deezer', capacity: 50, refillPerSec: 10 };
const BASE = 'https://api.deezer.com';

type DzError = { error?: { type: string; message: string; code: number } };
type DzTrack = DzError & { id: number; title: string; isrc?: string; duration: number; explicit_lyrics?: boolean; track_position?: number; release_date?: string; link?: string; artist?: { name: string }; contributors?: Array<{ name: string; role: string }>; album?: { id: number; title: string; release_date?: string; type?: string } };
type DzAlbum = DzError & { id: number; title: string; upc?: string; label?: string; release_date?: string; record_type?: string; link?: string; explicit_lyrics?: boolean; artist?: { name: string }; contributors?: Array<{ name: string; role: string }>; tracks?: { data: Array<{ id: number; title: string; duration: number; explicit_lyrics?: boolean; artist?: { name: string } }> } };

async function get<T extends DzError>(path: string): Promise<T | null> {
  const res = await fetchJson<T>(`${BASE}${path}`, { provider: 'deezer', rateLimit: RL, allow404: true });
  if (!res || res.error) return null; // Deezer reports "no data" as a 200 with an error object
  return res;
}

const artistsOf = (t: { artist?: { name: string }; contributors?: Array<{ name: string; role: string }> }) => {
  const main = t.contributors?.filter((c) => c.role === 'Main').map((c) => c.name) ?? [];
  return main.length ? main : t.artist ? [t.artist.name] : [];
};

export async function deezerTrack(id: string) {
  return get<DzTrack>(`/track/${encodeURIComponent(id)}`);
}

export async function deezerAlbum(id: string) {
  return get<DzAlbum>(`/album/${encodeURIComponent(id)}`);
}

function fromAlbum(album: DzAlbum, trackIsrcs: Map<number, string | null>): Partial<SourceResult> {
  const tracks: SourceTrack[] = (album.tracks?.data ?? []).map((t, i) => ({ title: t.title, isrc: trackIsrcs.get(t.id) ?? null, durationMs: t.duration ? t.duration * 1000 : null, position: i + 1, explicit: t.explicit_lyrics ?? null, artists: t.artist ? [t.artist.name] : [] }));
  return {
    upc: album.upc ? normalizeUpc(album.upc) : null,
    releaseTitle: album.title,
    releaseType: normType(album.record_type),
    releaseDate: album.release_date ?? null,
    labelName: album.label ?? null,
    tracks: tracks.length ? tracks : undefined,
  };
}

/** Look up by ISRC, UPC or Deezer ids; for albums, fetch each track to get its ISRC. */
export async function deezerLookup(q: Query & { deezerTrackId?: string; deezerAlbumId?: string; withTracklist?: boolean }): Promise<SourceResult | null> {
  let track: DzTrack | null = null;
  if (q.deezerTrackId) track = await deezerTrack(q.deezerTrackId);
  else if (q.isrc) track = await get<DzTrack>(`/track/isrc:${q.isrc}`);
  let album: DzAlbum | null = null;
  if (q.deezerAlbumId) album = await deezerAlbum(q.deezerAlbumId);
  else if (track?.album?.id) album = await deezerAlbum(String(track.album.id));
  else if (q.upc) album = (await get<DzAlbum>(`/album/upc:${q.upc}`)) ?? (q.upc.startsWith('0') ? await get<DzAlbum>(`/album/upc:${q.upc.slice(1)}`) : null);
  if (!track && !album) return null;

  const isrcs = new Map<number, string | null>();
  if (album && (q.withTracklist || !track) && (album.tracks?.data.length ?? 0) <= 40) {
    for (const t of album.tracks?.data ?? []) {
      const full = await deezerTrack(String(t.id));
      isrcs.set(t.id, full?.isrc ?? null);
    }
  }
  const result: SourceResult = {
    source: 'deezer',
    ...(album ? fromAlbum(album, isrcs) : {}),
    platformIds: [],
  };
  if (track) {
    Object.assign(result, {
      isrc: track.isrc ?? null,
      title: track.title,
      artists: artistsOf(track),
      durationMs: track.duration ? track.duration * 1000 : null,
      explicit: track.explicit_lyrics ?? null,
      releaseDate: result.releaseDate ?? track.release_date ?? track.album?.release_date ?? null,
    });
    result.platformIds!.push({ platform: 'deezer', entity: 'track', externalId: String(track.id), url: track.link ?? `https://www.deezer.com/track/${track.id}`, source: 'deezer' });
  } else if (album) {
    result.artists = artistsOf(album);
  }
  if (album) result.platformIds!.push({ platform: 'deezer', entity: 'release', externalId: String(album.id), url: album.link ?? `https://www.deezer.com/album/${album.id}`, source: 'deezer' });
  return result;
}

/** Text search ("title - artist") returning the best ISRC candidate. */
export async function deezerSearch(title: string, artist: string | null): Promise<{ trackId: string; title: string; artist: string } | null> {
  const q = artist ? `artist:"${artist}" track:"${title}"` : title;
  const res = await fetchJson<{ data?: Array<{ id: number; title: string; artist: { name: string } }> }>(`${BASE}/search?q=${encodeURIComponent(q)}&limit=5`, { provider: 'deezer', rateLimit: RL });
  const hit = res?.data?.[0];
  return hit ? { trackId: String(hit.id), title: hit.title, artist: hit.artist.name } : null;
}
