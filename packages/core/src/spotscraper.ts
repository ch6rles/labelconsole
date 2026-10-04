import type { ServiceContext } from './context';
import { env } from './env';
import { ProviderError, RateLimitedError } from './errors';
import { fetchJson } from './http';
import { getCredentialHandle, readSecret } from './vault';

/**
 * SpotScraper (https://spotscraper.readme.io): Spotify play counts, track
 * credits, ISRC search, album, artist and playlist data. Authenticated with
 * an `x-api-key` header, priced per request.
 *
 * Everything returned here is normalised into the small types below; raw
 * responses never leave this file, and agents only ever see numbers derived
 * from what the app stores. Podcast, audiobook and user endpoints exist but
 * have no use in a label console, so they are not wrapped.
 */
const API = 'https://api.spotscraper.com/v1';

export type SpotifyArtistRef = { id: string; name: string };
export type SpotifyTrack = {
  id: string;
  name: string;
  isrc: string | null;
  durationMs: number | null;
  explicit: boolean | null;
  popularity: number | null;
  /** Spotify's all-time play count; null when Spotify doesn't show one. */
  playCount: number | null;
  artists: SpotifyArtistRef[];
  album: { id: string; name: string; copyright: string | null } | null;
};
export type SpotifyAlbum = {
  id: string;
  name: string;
  upc: string | null;
  label: string | null;
  copyright: string | null;
  releaseDate: string | null;
  artists: SpotifyArtistRef[];
  totalTracks: number | null;
  tracks: Array<{ id: string; name: string; durationMs: number | null; trackNumber: number | null; playCount: number | null; artists: SpotifyArtistRef[] }>;
};
export type SpotifyCredit = { name: string; role: string };
export type SpotifyArtistStats = {
  id: string;
  name: string;
  verified: boolean | null;
  genres: string[];
  monthlyListeners: number | null;
  followers: number | null;
  worldRank: number | null;
  topCities: Array<{ city: string; country: string | null; listeners: number }>;
};
export type SpotifyPlaylist = { id: string; name: string; description: string | null; ownerId: string | null; ownerName: string | null; followers: number | null; trackCount: number | null; personalized: boolean | null };
/** One release in an artist's discography (no tracklist; read the album for that). */
export type SpotifyRelease = { id: string; name: string; type: 'album' | 'single' | 'ep' | 'compilation'; releaseDate: string | null; trackCount: number | null; imageUrl: string | null };
export type SpotifyPlaylistTrack = { id: string; name: string; position: number | null; addedAt: string | null; playCount: number | null; durationMs: number | null; artists: SpotifyArtistRef[]; album: { id: string; name: string } | null };

/* ------------------------------------------------------------- parsing -- */

type Obj = Record<string, unknown>;
const obj = (v: unknown): Obj | null => (v && typeof v === 'object' && !Array.isArray(v) ? (v as Obj) : null);
const arr = (v: unknown): unknown[] => (Array.isArray(v) ? v : []);
const str = (v: unknown): string | null => (typeof v === 'string' && v.trim() ? v.trim() : null);
const num = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : typeof v === 'string' && v.trim() && Number.isFinite(Number(v)) ? Number(v) : null);
const bool = (v: unknown): boolean | null => (typeof v === 'boolean' ? v : null);

/** Album track artists come with a `spotify:artist:ID` URI but no `id`. */
const idOf = (o: Obj, kind: string) => str(o.id) ?? str(o.uri)?.match(new RegExp(`^spotify:${kind}:([A-Za-z0-9]{22})$`))?.[1] ?? null;

const artistRefs = (v: unknown): SpotifyArtistRef[] =>
  arr(v)
    .map(obj)
    .filter((a): a is Obj => Boolean(a && idOf(a, 'artist') && str(a.name)))
    .map((a) => ({ id: idOf(a, 'artist')!, name: str(a.name)! }));

export function parseTrack(v: unknown): SpotifyTrack | null {
  const t = obj(v);
  if (!t || !str(t.id) || !str(t.name)) return null;
  const meta = obj(t.metadata) ?? {};
  const album = obj(t.album);
  return {
    id: str(t.id)!,
    name: str(t.name)!,
    isrc: str(t.isrc)?.toUpperCase().replace(/[^A-Z0-9]/g, '') ?? null,
    durationMs: num(meta.durationMs),
    explicit: bool(meta.explicit),
    popularity: num(t.popularity),
    playCount: num(obj(t.statistics)?.playCount),
    artists: artistRefs(t.artists),
    album: album && str(album.id) ? { id: str(album.id)!, name: str(album.name) ?? '', copyright: str(album.copyright) } : null,
  };
}

export function parseAlbum(v: unknown): SpotifyAlbum | null {
  const a = obj(v);
  if (!a || !str(a.id) || !str(a.name)) return null;
  const meta = obj(a.metadata) ?? {};
  const tracks = obj(a.tracks) ?? {};
  return {
    id: str(a.id)!,
    name: str(a.name)!,
    upc: str(a.upc) ?? str(a.ean),
    label: str(meta.label),
    copyright: str(meta.copyright),
    releaseDate: isoDay(meta.releasedOn),
    artists: artistRefs(a.artists),
    totalTracks: num(tracks.total),
    tracks: arr(tracks.items)
      .map(obj)
      .filter((t): t is Obj => Boolean(t && str(t.id)))
      .map((t) => ({ id: str(t.id)!, name: str(t.name) ?? '', durationMs: num(obj(t.metadata)?.durationMs), trackNumber: num(obj(t.metadata)?.trackNumber), playCount: num(obj(t.statistics)?.playCount), artists: artistRefs(t.artists) })),
  };
}

export function parseArtist(v: unknown): SpotifyArtistStats | null {
  const a = obj(v);
  if (!a || !str(a.id) || !str(a.name)) return null;
  const stats = obj(a.statistics) ?? {};
  return {
    id: str(a.id)!,
    name: str(a.name)!,
    verified: bool(obj(a.metadata)?.verified),
    genres: arr(a.genres).map(str).filter((g): g is string => Boolean(g)),
    monthlyListeners: num(stats.monthlyListeners),
    followers: num(stats.followers),
    worldRank: num(stats.worldRank) || null, // Spotify reports 0 for artists outside the ranking
    topCities: arr(stats.topCities)
      .map(obj)
      .filter((c): c is Obj => Boolean(c && str(c.city) && num(c.listenerCount) != null))
      .map((c) => ({ city: str(c.city)!, country: str(c.country), listeners: num(c.listenerCount)! })),
  };
}

export function parsePlaylist(v: unknown): SpotifyPlaylist | null {
  const p = obj(v);
  if (!p || !str(p.id)) return null;
  const meta = obj(p.metadata) ?? {};
  const stats = obj(p.statistics) ?? {};
  const owner = obj(p.owner) ?? {};
  return {
    id: str(p.id)!,
    name: str(p.name) ?? '',
    description: str(meta.description),
    ownerId: str(owner.id),
    ownerName: str(owner.name),
    followers: num(stats.followers),
    trackCount: num(stats.trackCount) ?? num(obj(p.tracks)?.total),
    personalized: bool(meta.personalized),
  };
}

const isoDay = (v: unknown) => {
  const s = str(v);
  return s && !Number.isNaN(Date.parse(s)) ? new Date(s).toISOString().slice(0, 10) : null;
};

/** The artist's own releases, grouped by Spotify as albums, singles, EPs (and compilations when present). */
export function parseDiscography(v: unknown): SpotifyRelease[] {
  const d = obj(v) ?? {};
  const groups: Array<[string, SpotifyRelease['type']]> = [
    ['albums', 'album'],
    ['singles', 'single'],
    ['eps', 'ep'],
    ['compilations', 'compilation'],
  ];
  const seen = new Set<string>();
  const out: SpotifyRelease[] = [];
  for (const [key, fallback] of groups) {
    for (const item of arr(obj(d[key])?.items)) {
      const a = obj(item);
      const id = a ? idOf(a, 'album') : null;
      if (!a || !id || !str(a.name) || seen.has(id)) continue;
      seen.add(id);
      const type = str(a.type)?.toLowerCase();
      const images = arr(obj(a.images)?.sources).map(obj).filter((i): i is Obj => Boolean(i && str(i.url)));
      const largest = images.sort((x, y) => (num(y.width) ?? 0) - (num(x.width) ?? 0))[0];
      out.push({
        id,
        name: str(a.name)!,
        type: type === 'album' || type === 'single' || type === 'ep' || type === 'compilation' ? type : fallback,
        releaseDate: isoDay(obj(a.metadata)?.releasedOn),
        trackCount: num(obj(a.tracks)?.totalCount) ?? num(obj(a.tracks)?.total),
        imageUrl: largest ? str(largest.url) : null,
      });
    }
  }
  return out.sort((x, y) => (y.releaseDate ?? '').localeCompare(x.releaseDate ?? ''));
}

export function parsePlaylistTracks(v: unknown): SpotifyPlaylistTrack[] {
  return arr(obj(obj(v)?.tracks)?.items)
    .map(obj)
    .filter((t): t is Obj => Boolean(t && idOf(t, 'track') && str(t.name)))
    .map((t) => {
      const meta = obj(t.metadata) ?? {};
      const album = obj(t.album);
      const albumId = album ? idOf(album, 'album') : null;
      return {
        id: idOf(t, 'track')!,
        name: str(t.name)!,
        position: num(meta.position),
        addedAt: str(meta.addedAt),
        playCount: num(obj(t.statistics)?.playCount),
        durationMs: num(meta.durationMs),
        artists: artistRefs(t.artists),
        album: album && albumId ? { id: albumId, name: str(album.name) ?? '' } : null,
      };
    });
}

const SPOTIFY_ID = /^[A-Za-z0-9]{22}$/;

/** A Spotify ID from a bare ID, an open.spotify.com link or a spotify: URI, if it is of the given kind. */
export function spotifyIdFrom(input: string | null | undefined, kind: 'track' | 'album' | 'artist' | 'playlist'): string | null {
  const s = input?.trim();
  if (!s) return null;
  if (SPOTIFY_ID.test(s)) return s;
  const uri = s.match(/^spotify:([a-z]+):([A-Za-z0-9]{22})$/);
  if (uri) return uri[1] === kind ? uri[2] : null;
  try {
    const u = new URL(s);
    if (!/(^|\.)spotify\.com$/.test(u.hostname)) return null;
    // Paths look like /track/ID, /intl-de/track/ID or /embed/track/ID.
    const parts = u.pathname.split('/').filter(Boolean);
    const i = parts.indexOf(kind);
    return i >= 0 && SPOTIFY_ID.test(parts[i + 1] ?? '') ? parts[i + 1] : null;
  } catch {
    return null;
  }
}

/* -------------------------------------------------------------- client -- */

function keyHash(apiKey: string) {
  let h = 0;
  for (const c of apiKey) h = (h * 31 + c.charCodeAt(0)) | 0;
  return (h >>> 0).toString(36);
}

export class SpotScraperClient {
  /** Requests made by this client, for usage accounting (SpotScraper bills per request). */
  requests = 0;
  private readonly rateKey: string;

  constructor(private readonly apiKey: string) {
    this.rateKey = `spotscraper:${keyHash(apiKey)}`;
  }

  private async get(path: string, signal?: AbortSignal): Promise<unknown | null> {
    this.requests++;
    let res: { data?: unknown } | null;
    try {
      res = await fetchJson<{ data?: unknown }>(`${API}${path}`, {
        provider: 'spotscraper',
        headers: { 'x-api-key': this.apiKey },
        // Shared across workers: a steady pace well under what a pay-as-you-go key allows.
        rateLimit: { key: this.rateKey, capacity: 10, refillPerSec: 5 },
        allow404: true,
        timeoutMs: 30_000,
        retries: 2,
        signal,
      });
    } catch (err) {
      if (err instanceof ProviderError && err.upstreamStatus === 429) throw new RateLimitedError(err.retryAfterMs ?? 30_000, 'SpotScraper rate limit');
      // A rejected key comes back as 400 with a plain-text body, or as 401/403.
      if (err instanceof ProviderError && (err.upstreamStatus === 401 || err.upstreamStatus === 403 || (err.upstreamStatus === 400 && !err.message.includes('{')))) {
        throw new ProviderError('spotscraper', 'SpotScraper refused the API key. Update it under Settings → Integrations.', { status: err.upstreamStatus, transient: false });
      }
      throw err;
    }
    return res?.data ?? null;
  }

  async track(id: string, signal?: AbortSignal): Promise<SpotifyTrack | null> {
    if (!SPOTIFY_ID.test(id)) return null;
    return parseTrack(await this.get(`/tracks/${id}`, signal));
  }

  /** Every Spotify track carrying this ISRC (re-releases and compilations share one), most popular first. */
  async searchIsrc(isrc: string, signal?: AbortSignal): Promise<SpotifyTrack[]> {
    const code = isrc.toUpperCase().replace(/[^A-Z0-9]/g, '');
    if (!/^[A-Z]{2}[A-Z0-9]{3}\d{7}$/.test(code)) return [];
    const data = obj(await this.get(`/tracks/search/isrc/${code}?limit=20`, signal));
    return arr(data?.tracks)
      .map(parseTrack)
      .filter((t): t is SpotifyTrack => Boolean(t))
      .sort((a, b) => (b.popularity ?? 0) - (a.popularity ?? 0));
  }

  async credits(trackId: string, signal?: AbortSignal): Promise<{ credits: SpotifyCredit[]; copyright: string | null } | null> {
    if (!SPOTIFY_ID.test(trackId)) return null;
    const data = obj(await this.get(`/tracks/${trackId}/credits`, signal));
    if (!data) return null;
    const credits = arr(data.credits)
      .map(obj)
      .filter((c): c is Obj => Boolean(c && str(c.name) && str(c.role)))
      .map((c) => ({ name: str(c.name)!, role: str(c.role)! }));
    return { credits, copyright: str(data.copyright) };
  }

  async album(id: string, signal?: AbortSignal): Promise<SpotifyAlbum | null> {
    if (!SPOTIFY_ID.test(id)) return null;
    return parseAlbum(await this.get(`/albums/${id}`, signal));
  }

  async artist(id: string, signal?: AbortSignal): Promise<SpotifyArtistStats | null> {
    if (!SPOTIFY_ID.test(id)) return null;
    return parseArtist(await this.get(`/artists/${id}`, signal));
  }

  /** Playlists where listeners discovered this artist ("Discovered on" on the artist page). */
  async discoveredOn(artistId: string, limit = 50, signal?: AbortSignal): Promise<SpotifyPlaylist[]> {
    if (!SPOTIFY_ID.test(artistId)) return [];
    const data = await this.get(`/artists/${artistId}/discovered_on?limit=${Math.max(1, Math.min(limit, 200))}`, signal);
    // Live responses nest the list as { playlists: { totalCount, items } } (the reference shows a bare array); accept both.
    const items = Array.isArray(data) ? data : arr(obj(obj(data)?.playlists)?.items);
    return items.map(parsePlaylist).filter((p): p is SpotifyPlaylist => Boolean(p));
  }

  async playlist(id: string, signal?: AbortSignal): Promise<SpotifyPlaylist | null> {
    if (!SPOTIFY_ID.test(id)) return null;
    return parsePlaylist(await this.get(`/playlists/${id}`, signal));
  }

  /** The tracks on a playlist in playlist order, with when each was added and its play count. */
  async playlistTracks(id: string, signal?: AbortSignal): Promise<SpotifyPlaylistTrack[]> {
    if (!SPOTIFY_ID.test(id)) return [];
    return parsePlaylistTracks(await this.get(`/playlists/${id}/tracks`, signal));
  }

  /** The artist's albums, singles and EPs, newest first; null when Spotify has no such artist. */
  async discography(artistId: string, signal?: AbortSignal): Promise<SpotifyRelease[] | null> {
    if (!SPOTIFY_ID.test(artistId)) return null;
    const data = await this.get(`/artists/${artistId}/discography`, signal);
    return data ? parseDiscography(data) : null;
  }
}

/* -------------------------------------------------------- credentials -- */

type Factory = (ctx: ServiceContext) => Promise<SpotScraperClient | null>;
let override: Factory | null = null;

/** Tests swap in a client backed by recorded responses here. */
export function setSpotScraperFactory(f: Factory | null) {
  override = f;
}

/** Whether SpotScraper is available to this label, without decrypting anything (safe in the web process). */
export async function spotScraperConfigured(ctx: ServiceContext): Promise<boolean> {
  if (override) return Boolean(await override(ctx));
  if (env().SPOTSCRAPER_API_KEY) return true;
  return Boolean(await getCredentialHandle(ctx, 'spotscraper'));
}

/** The label's own key from the vault, else the platform key, else null. Worker only for vault keys. */
export async function spotScraperFor(ctx: ServiceContext): Promise<SpotScraperClient | null> {
  if (override) return override(ctx);
  if (await getCredentialHandle(ctx, 'spotscraper')) {
    const own = await readSecret(ctx, 'spotscraper');
    if (own?.secret.apiKey) return new SpotScraperClient(own.secret.apiKey);
  }
  const key = env().SPOTSCRAPER_API_KEY;
  return key ? new SpotScraperClient(key) : null;
}

/** Split Spotify's single copyright string into ℗ (sound recording) and © (composition) lines. */
export function copyrightLines(text: string | null | undefined): { pLine: string | null; cLine: string | null } {
  const t = text?.trim();
  if (!t) return { pLine: null, cLine: null };
  if (/^(\(P\)|℗|P\s)/i.test(t)) return { pLine: t, cLine: null };
  if (/^(\(C\)|©|C\s)/i.test(t)) return { pLine: null, cLine: t };
  return { pLine: null, cLine: null };
}

/** A name for comparing artists across sources: lower case, no accents or punctuation. */
export const normName = (s: string) =>
  s
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();

/**
 * The Spotify track that stands for an ISRC. Every search result carries the
 * ISRC, so this only chooses between releases of the same recording: prefer
 * one by the track's own artist, then the most popular (usually the original
 * release, which holds the play count).
 */
export function pickIsrcMatch(results: SpotifyTrack[], isrc: string, artists: string[]): SpotifyTrack | null {
  const code = isrc.toUpperCase().replace(/[^A-Z0-9]/g, '');
  const exact = results.filter((t) => t.isrc === code);
  if (exact.length === 0) return null;
  const names = artists.map(normName).filter(Boolean);
  const byArtist = names.length ? exact.filter((t) => t.artists.some((a) => names.includes(normName(a.name)))) : [];
  const pool = byArtist.length ? byArtist : exact;
  return [...pool].sort((a, b) => (b.popularity ?? 0) - (a.popularity ?? 0) || (b.playCount ?? 0) - (a.playCount ?? 0))[0] ?? null;
}
