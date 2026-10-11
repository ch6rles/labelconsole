import { fetchJson } from '@labelconsole/core/http';
import { normalizeIsrc } from './input';

/**
 * Text search that keeps every plausible match instead of taking the first,
 * so a caller can ask "which one?" rather than guess. Deezer first (fast, no
 * key); MusicBrainz only when Deezer finds nothing (it allows 1 request/s).
 */
export type SearchCandidate = {
  /** `dz:<deezer track id>` or `isrc:<ISRC>`: what to resolve when this one is picked. */
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
};

type DzHit = { id: number; title: string; duration?: number; explicit_lyrics?: boolean; artist?: { name: string }; album?: { title?: string } };
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

async function deezer(q: string): Promise<DzHit[]> {
  const res = await fetchJson<{ data?: DzHit[]; error?: unknown }>(`https://api.deezer.com/search?q=${encodeURIComponent(q)}&limit=10`, { provider: 'deezer', rateLimit: DEEZER_RL });
  return res?.data ?? [];
}

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
  let hits = await deezer(artist ? `artist:"${artist.replace(/"/g, '')}" track:"${title.replace(/"/g, '')}"` : title);
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
    if (seen.has(id) || seen.has(c.key)) continue;
    seen.add(id);
    seen.add(c.key);
    unique.push({ ...c, exact: isExact(c, title, artist) });
  }
  // Exact matches first; otherwise keep the provider's relevance order.
  return [...unique.filter((c) => c.exact), ...unique.filter((c) => !c.exact)].slice(0, limit);
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
