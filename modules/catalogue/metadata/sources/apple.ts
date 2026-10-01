import { fetchJson } from '@labelconsole/core/http';
import { normalizeUpc } from '../input';
import type { Query, SourceResult } from './types';

/** Apple Music API with the label's MusicKit developer token; iTunes lookup (public) as a fallback. */
const RL = { key: 'apple-music', capacity: 20, refillPerSec: 5 };

export type AppleSecret = { developerToken: string; storefront?: string };

type AmSong = { id: string; attributes: { name: string; isrc?: string; artistName: string; durationInMillis?: number; releaseDate?: string; contentRating?: string; url?: string; albumName?: string }; relationships?: { albums?: { data: AmAlbum[] } } };
type AmAlbum = { id: string; attributes: { name: string; upc?: string; recordLabel?: string; copyright?: string; releaseDate?: string; artistName: string; isSingle?: boolean; trackCount?: number; url?: string } };

async function api<T>(secret: AppleSecret, path: string) {
  return fetchJson<T>(`https://api.music.apple.com/v1/catalog/${secret.storefront || 'us'}${path}`, { provider: 'apple_music', headers: { authorization: `Bearer ${secret.developerToken}` }, rateLimit: RL, allow404: true });
}

function albumFields(a: AmAlbum | undefined): Partial<SourceResult> {
  if (!a) return {};
  return {
    upc: a.attributes.upc ? normalizeUpc(a.attributes.upc) : null,
    releaseTitle: a.attributes.name,
    releaseDate: a.attributes.releaseDate ?? null,
    labelName: a.attributes.recordLabel ?? null,
    cLine: a.attributes.copyright ?? null,
    releaseType: a.attributes.isSingle ? 'single' : (a.attributes.trackCount ?? 0) <= 6 ? 'ep' : 'album',
  };
}

export async function appleLookup(secret: AppleSecret, q: Query & { appleSongId?: string; appleAlbumId?: string }): Promise<SourceResult | null> {
  let song: AmSong | undefined;
  if (q.appleSongId) song = (await api<{ data: AmSong[] }>(secret, `/songs/${q.appleSongId}?include=albums`))?.data[0];
  else if (q.isrc) {
    const s = (await api<{ data: AmSong[] }>(secret, `/songs?filter[isrc]=${q.isrc}`))?.data[0];
    if (s) song = (await api<{ data: AmSong[] }>(secret, `/songs/${s.id}?include=albums`))?.data[0] ?? s;
  }
  let album: AmAlbum | undefined = song?.relationships?.albums?.data[0];
  if (!album && q.appleAlbumId) album = (await api<{ data: AmAlbum[] }>(secret, `/albums/${q.appleAlbumId}`))?.data[0];
  if (!album && q.upc) album = (await api<{ data: AmAlbum[] }>(secret, `/albums?filter[upc]=${q.upc.replace(/^0/, '')}`))?.data[0];
  if (!song && !album) return null;
  return {
    source: 'apple',
    ...albumFields(album),
    isrc: song?.attributes.isrc ?? null,
    title: song?.attributes.name ?? null,
    artists: song ? [song.attributes.artistName] : album ? [album.attributes.artistName] : [],
    durationMs: song?.attributes.durationInMillis ?? null,
    explicit: song ? song.attributes.contentRating === 'explicit' : null,
    platformIds: [
      ...(song ? [{ platform: 'apple', entity: 'track' as const, externalId: song.id, url: song.attributes.url ?? null, source: 'apple' }] : []),
      ...(album ? [{ platform: 'apple', entity: 'release' as const, externalId: album.id, url: album.attributes.url ?? null, source: 'apple' }] : []),
    ],
  };
}

type ItunesResult = { wrapperType: string; collectionId?: number; collectionName?: string; artistName?: string; copyright?: string; releaseDate?: string; trackCount?: number; collectionViewUrl?: string; trackId?: number; trackName?: string; trackNumber?: number; trackTimeMillis?: number; trackExplicitness?: string; trackViewUrl?: string };

/** iTunes Search API lookup by UPC (no auth): copyright line, release date and tracklist. */
export async function itunesLookup(q: Query & { itunesId?: string }): Promise<SourceResult | null> {
  if (!q.upc && !q.itunesId) return null;
  const param = q.itunesId ? `id=${q.itunesId}` : `upc=${q.upc!.replace(/^0/, '')}`;
  const res = await fetchJson<{ results: ItunesResult[] }>(`https://itunes.apple.com/lookup?${param}&entity=song`, { provider: 'itunes', rateLimit: { key: 'itunes', capacity: 20, refillPerSec: 0.33 }, allow404: true });
  const coll = res?.results.find((r) => r.wrapperType === 'collection');
  if (!coll) return null;
  const songs = res!.results.filter((r) => r.wrapperType === 'track');
  return {
    source: 'itunes',
    releaseTitle: coll.collectionName ?? null,
    releaseDate: coll.releaseDate?.slice(0, 10) ?? null,
    cLine: coll.copyright ?? null,
    artists: coll.artistName ? [coll.artistName] : [],
    tracks: songs.map((s) => ({ title: s.trackName ?? '', isrc: null, durationMs: s.trackTimeMillis ?? null, position: s.trackNumber ?? 0, explicit: s.trackExplicitness ? s.trackExplicitness === 'explicit' : null, artists: s.artistName ? [s.artistName] : [] })),
    platformIds: coll.collectionId ? [{ platform: 'apple', entity: 'release', externalId: String(coll.collectionId), url: coll.collectionViewUrl ?? null, source: 'itunes' }] : [],
  };
}
