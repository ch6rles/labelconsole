import { fetchJson } from '@labelconsole/core/http';
import { normalizeIsrc } from './input';

/**
 * Text search that keeps every plausible match instead of taking the first,
 * so a caller can ask "which one?" rather than guess. Deezer first (fast, no
 * key); MusicBrainz only when Deezer finds nothing (it allows 1 request/s).
 */
export type SearchCandidate = {
  /** `dz:<deezer track id>`, `isrc:<ISRC>` or (releases) `dza:<deezer album id>`: what to resolve when this one is picked. */
  key: string;
  source: 'deezer' | 'musicbrainz';
  title: string;
  artists: string[];
  album: string | null;
  durationMs: number | null;
  year: string | null;
  explicit: boolean | null;
  /** Title and artist match what was asked for exactly (versions like "(Remix)" do not match a plain title). */
  exact: boolean;
  isrc?: string | null;
  /** Releases: single, EP, album or compilation, and the number of tracks. */
  releaseType?: string | null;
  trackCount?: number | null;
};

type DzHit = { id: number; title: string; duration?: number; explicit_lyrics?: boolean; isrc?: string; artist?: { name: string }; album?: { title?: string } };
type DzAlbumHit = { id: number; title: string; record_type?: string; nb_tracks?: number; explicit_lyrics?: boolean; artist?: { name: string } };
type MbHit = { id: string; title: string; score?: number; length?: number; isrcs?: string[]; 'artist-credit'?: Array<{ name: string }>; releases?: Array<{ title?: string; date?: string; status?: string }> };

const DEEZER_RL = { key: 'deezer', capacity: 50, refillPerSec: 10 };
const MB_RL = { key: 'musicbrainz', capacity: 1, refillPerSec: 1 };

/** Lowercase, no accents or punctuation; keeps version words so "Song (Remix)" stays distinct from "Song". */
export const normText = (s: string | null | undefined) =>
  (s ?? '')
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/&/g, ' and ')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();

function isExact(c: { title: string; artists: string[] }, title: string, artist: string | null) {
  const t = normText(c.title);
  const names = c.artists.map(normText);
  const artistMatches = (a: string) => names.some((n) => n === normText(a));
  if (t === normText(title) && (!artist || artistMatches(artist))) return true;
  // "Title - Artist" typed the other way round.
  return Boolean(artist) && t === normText(artist) && artistMatches(title);
}

async function deezer<T = DzHit>(q: string, kind: 'track' | 'album' = 'track'): Promise<T[]> {
  const path = kind === 'album' ? 'search/album' : 'search';
  const res = await fetchJson<{ data?: T[]; error?: unknown }>(`https://api.deezer.com/${path}?q=${encodeURIComponent(q)}&limit=10`, { provider: 'deezer', rateLimit: DEEZER_RL });
  return res?.data ?? [];
}

const deezerQuery = (title: string, artist: string | null, field: 'track' | 'album') => (artist ? `artist:"${artist.replace(/"/g, '')}" ${field}:"${title.replace(/"/g, '')}"` : title);

async function musicbrainz(title: string, artist: string | null): Promise<MbHit[]> {
  const query = `recording:"${title.replace(/"/g, '')}"${artist ? ` AND artist:"${artist.replace(/"/g, '')}"` : ''}`;
  const res = await fetchJson<{ recordings?: MbHit[] }>(`https://musicbrainz.org/ws/2/recording/?query=${encodeURIComponent(query)}&limit=10&fmt=json`, {
    provider: 'musicbrainz',
    rateLimit: MB_RL,
    allow404: true,
    timeoutMs: 20_000,
  });
  return (res?.recordings ?? []).filter((r) => (r.score ?? 0) >= 70);
}

export async function searchCandidates(title: string, artist: string | null, limit = 5): Promise<SearchCandidate[]> {
  let hits = await deezer(deezerQuery(title, artist, 'track'));
  // The strict query finds nothing when the parts are swapped or slightly off.
  if (!hits.length && artist) hits = await deezer(`${artist} ${title}`);
  let found: SearchCandidate[] = hits.map((h) => ({
    key: `dz:${h.id}`,
    source: 'deezer' as const,
    title: h.title,
    artists: h.artist?.name ? [h.artist.name] : [],
    album: h.album?.title ?? null,
    durationMs: h.duration ? h.duration * 1000 : null,
    year: null,
    explicit: h.explicit_lyrics ?? null,
    exact: false,
    isrc: h.isrc ? normalizeIsrc(h.isrc) : null,
  }));
  if (!found.length) {
    found = (await musicbrainz(title, artist))
      .map((r) => {
        const isrc = r.isrcs?.map(normalizeIsrc).find(Boolean);
        if (!isrc) return null; // nothing to resolve it by
        const release = r.releases?.find((x) => x.status === 'Official') ?? r.releases?.[0];
        return {
          key: `isrc:${isrc}`,
          source: 'musicbrainz' as const,
          title: r.title,
          artists: (r['artist-credit'] ?? []).map((a) => a.name),
          album: release?.title ?? null,
          durationMs: r.length ?? null,
          year: release?.date?.slice(0, 4) ?? null,
          explicit: null,
          exact: false,
        };
      })
      .filter((c): c is NonNullable<typeof c> => c !== null);
  }

  // The same recording often appears on a single and its album: show it once.
  const seen = new Set<string>();
  const unique: SearchCandidate[] = [];
  for (const c of found) {
    const id = `${normText(c.title)}|${normText(c.artists[0])}|${c.durationMs ? Math.round(c.durationMs / 2000) : ''}`;
    if (seen.has(id) || seen.has(c.key) || (c.isrc && seen.has(c.isrc))) continue;
    seen.add(id);
    seen.add(c.key);
    if (c.isrc) seen.add(c.isrc);
    unique.push({ ...c, exact: isExact(c, title, artist) });
  }
  // Exact matches first; otherwise keep the provider's relevance order.
  return [...unique.filter((c) => c.exact), ...unique.filter((c) => !c.exact)].slice(0, limit);
}

/** Releases (albums, EPs, singles) matching a title, for /release. Same matching rules as tracks. */
export async function searchReleaseCandidates(title: string, artist: string | null, limit = 5): Promise<SearchCandidate[]> {
  let hits = await deezer<DzAlbumHit>(deezerQuery(title, artist, 'album'), 'album');
  if (!hits.length && artist) hits = await deezer<DzAlbumHit>(`${artist} ${title}`, 'album');
  const seen = new Set<string>();
  const out: SearchCandidate[] = [];
  for (const h of hits) {
    const c: SearchCandidate = {
      key: `dza:${h.id}`,
      source: 'deezer',
      title: h.title,
      artists: h.artist?.name ? [h.artist.name] : [],
      album: null,
      durationMs: null,
      year: null,
      explicit: h.explicit_lyrics ?? null,
      exact: false,
      releaseType: h.record_type ?? null,
      trackCount: h.nb_tracks ?? null,
    };
    const id = `${normText(c.title)}|${normText(c.artists[0])}|${c.releaseType}|${c.trackCount}`;
    if (seen.has(id)) continue;
    seen.add(id);
    out.push({ ...c, exact: isExact(c, title, artist) });
  }
  return [...out.filter((c) => c.exact), ...out.filter((c) => !c.exact)].slice(0, limit);
}

/**
 * The candidate to use without asking, or null when the person should choose.
 * Only an exact title (and artist, if given) match qualifies, and only when it
 * is the one exact match for a query that named the artist, or the only
 * result at all. A lone near-miss is still shown for confirmation.
 */
export function unambiguousCandidate(candidates: SearchCandidate[], artist: string | null): SearchCandidate | null {
  const exact = candidates.filter((c) => c.exact);
  if (exact.length !== 1) return null;
  return artist || candidates.length === 1 ? exact[0] : null;
}
