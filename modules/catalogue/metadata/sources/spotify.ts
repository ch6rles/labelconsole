import { fetchJson } from '@labelconsole/core/http';
import { ProviderError } from '@labelconsole/core/errors';
import { normalizeUpc } from '../input';
import type { Query, SourceResult } from './types';
import { normType } from './types';

/**
 * Spotify Web API, metadata only (ISRC, UPC, copyright lines) and only with
 * the label's own credentials and access level. Never used for stream counts,
 * and its responses are normalised here and never passed to an LLM.
 */
const RL = { key: 'spotify', capacity: 10, refillPerSec: 3 };
const tokens = new Map<string, { token: string; exp: number }>();

export type SpotifySecret = { clientId: string; clientSecret: string };

async function token(secret: SpotifySecret) {
  const cached = tokens.get(secret.clientId);
  if (cached && cached.exp > Date.now() + 30_000) return cached.token;
  const res = await fetch('https://accounts.spotify.com/api/token', {
    method: 'POST',
    headers: { authorization: `Basic ${Buffer.from(`${secret.clientId}:${secret.clientSecret}`).toString('base64')}`, 'content-type': 'application/x-www-form-urlencoded' },
    body: 'grant_type=client_credentials',
    signal: AbortSignal.timeout(15_000),
  });
  const json = (await res.json().catch(() => ({}))) as { access_token?: string; expires_in?: number; error_description?: string };
  if (!res.ok || !json.access_token) throw new ProviderError('spotify', json.error_description ?? `token request failed (${res.status})`, { status: res.status });
  tokens.set(secret.clientId, { token: json.access_token, exp: Date.now() + (json.expires_in ?? 3600) * 1000 });
  return json.access_token;
}

type SpTrack = { id: string; name: string; duration_ms: number; explicit: boolean; external_ids?: { isrc?: string }; artists: Array<{ name: string }>; album: { id: string }; external_urls?: { spotify?: string }; track_number?: number };
type SpAlbum = { id: string; name: string; album_type: string; release_date: string; label?: string; external_ids?: { upc?: string; ean?: string }; copyrights?: Array<{ text: string; type: 'C' | 'P' }>; artists: Array<{ name: string }>; external_urls?: { spotify?: string }; tracks?: { items: Array<{ id: string; name: string; duration_ms: number; explicit: boolean; track_number: number; artists: Array<{ name: string }> }> } };

async function api<T>(secret: SpotifySecret, path: string) {
  return fetchJson<T>(`https://api.spotify.com/v1${path}`, { provider: 'spotify', headers: { authorization: `Bearer ${await token(secret)}` }, rateLimit: RL, allow404: true });
}

export async function spotifyLookup(secret: SpotifySecret, q: Query & { spotifyTrackId?: string; spotifyAlbumId?: string }): Promise<SourceResult | null> {
  let track: SpTrack | null = null;
  if (q.spotifyTrackId) track = await api<SpTrack>(secret, `/tracks/${q.spotifyTrackId}`);
  else if (q.isrc) track = (await api<{ tracks: { items: SpTrack[] } }>(secret, `/search?type=track&limit=1&q=${encodeURIComponent(`isrc:${q.isrc}`)}`))?.tracks.items[0] ?? null;
  let album: SpAlbum | null = null;
  const albumId = q.spotifyAlbumId ?? track?.album.id;
  if (albumId) album = await api<SpAlbum>(secret, `/albums/${albumId}`);
  else if (q.upc) {
    const hit = (await api<{ albums: { items: Array<{ id: string }> } }>(secret, `/search?type=album&limit=1&q=${encodeURIComponent(`upc:${q.upc.replace(/^0/, '')}`)}`))?.albums.items[0];
    if (hit) album = await api<SpAlbum>(secret, `/albums/${hit.id}`);
  }
  if (!track && !album) return null;
  const copyright = (type: 'C' | 'P') => album?.copyrights?.find((c) => c.type === type)?.text ?? null;
  return {
    source: 'spotify',
    isrc: track?.external_ids?.isrc ?? null,
    title: track?.name ?? null,
    artists: (track?.artists ?? album?.artists ?? []).map((a) => a.name),
    durationMs: track?.duration_ms ?? null,
    explicit: track?.explicit ?? null,
    upc: album?.external_ids?.upc ? normalizeUpc(album.external_ids.upc) : album?.external_ids?.ean ? normalizeUpc(album.external_ids.ean) : null,
    releaseTitle: album?.name ?? null,
    releaseType: normType(album?.album_type),
    releaseDate: album?.release_date ?? null,
    labelName: album?.label ?? null,
    pLine: copyright('P'),
    cLine: copyright('C'),
    tracks: album?.tracks?.items.map((t) => ({ title: t.name, isrc: null, durationMs: t.duration_ms, position: t.track_number, explicit: t.explicit, artists: t.artists.map((a) => a.name) })),
    platformIds: [
      ...(track ? [{ platform: 'spotify', entity: 'track' as const, externalId: track.id, url: track.external_urls?.spotify ?? `https://open.spotify.com/track/${track.id}`, source: 'spotify' }] : []),
      ...(album ? [{ platform: 'spotify', entity: 'release' as const, externalId: album.id, url: album.external_urls?.spotify ?? `https://open.spotify.com/album/${album.id}`, source: 'spotify' }] : []),
    ],
  };
}

/** Public oEmbed: a Spotify link's title, used to search other sources when no credentials are set. */
export async function spotifyOEmbedTitle(url: string): Promise<string | null> {
  const res = await fetchJson<{ title?: string }>(`https://open.spotify.com/oembed?url=${encodeURIComponent(url)}`, { provider: 'spotify', allow404: true, retries: 1 });
  return res?.title ?? null;
}
