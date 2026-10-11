import { fetchJson } from '@labelconsole/core/http';
import { normalizeUpc } from '../input';
import type { Query, SourceResult, SourceTrack } from './types';
import { normType } from './types';

/**
 * Discogs: release-level data (labels, catalogue numbers, formats, the
 * companies behind a release) and credits. Community-maintained. Searching by
 * barcode needs a personal access token; 60 requests a minute with one.
 */
const RL = { key: 'discogs', capacity: 10, refillPerSec: 1 };
const BASE = 'https://api.discogs.com';

export type DiscogsSecret = { token: string };

type DgArtist = { name: string; anv?: string; role?: string; tracks?: string };
export type DgRelease = {
  id: number;
  title: string;
  released?: string;
  year?: number;
  uri?: string;
  artists?: DgArtist[];
  extraartists?: DgArtist[];
  labels?: Array<{ name: string; catno?: string }>;
  companies?: Array<{ name: string; entity_type_name?: string }>;
  formats?: Array<{ name: string; descriptions?: string[] }>;
  identifiers?: Array<{ type: string; value: string }>;
  images?: Array<{ type: string; uri?: string }>;
  tracklist?: Array<{ position?: string; type_?: string; title: string; duration?: string; extraartists?: DgArtist[]; artists?: DgArtist[] }>;
};

const headers = (s: DiscogsSecret) => ({ authorization: `Discogs token=${s.token.trim()}` });
/** Discogs appends " (2)" to tell apart artists and labels with the same name. */
const clean = (name: string) => name.replace(/\s\(\d+\)$/, '').trim();

export async function discogsRelease(secret: DiscogsSecret, id: number | string): Promise<DgRelease | null> {
  if (!/^\d{1,12}$/.test(String(id))) return null;
  return fetchJson<DgRelease>(`${BASE}/releases/${id}`, { provider: 'discogs', headers: headers(secret), rateLimit: RL, allow404: true });
}

function duration(s: string | undefined) {
  const m = s ? /^(\d+):(\d{2})$/.exec(s) : null;
  return m ? (Number(m[1]) * 60 + Number(m[2])) * 1000 : null;
}

export function fromDiscogs(r: DgRelease): SourceResult {
  const barcode = r.identifiers?.find((i) => i.type === 'Barcode')?.value;
  const format = r.formats?.[0];
  const descr = (format?.descriptions ?? []).map((d) => d.toLowerCase());
  const tracks: SourceTrack[] = (r.tracklist ?? [])
    .filter((t) => !t.type_ || t.type_ === 'track')
    .map((t, i) => ({ title: t.title, isrc: null, durationMs: duration(t.duration), position: i + 1, explicit: null, artists: (t.artists ?? r.artists ?? []).map((a) => clean(a.name)) }));
  return {
    source: 'discogs',
    upc: barcode ? normalizeUpc(barcode) : null,
    releaseTitle: r.title,
    releaseType: normType(descr.includes('single') ? 'single' : descr.includes('ep') ? 'ep' : descr.includes('compilation') ? 'compilation' : descr.includes('album') || descr.includes('lp') ? 'album' : null),
    releaseDate: r.released && /^\d{4}(-\d{2}(-\d{2})?)?$/.test(r.released) && !r.released.endsWith('-00') ? r.released : r.year ? String(r.year) : null,
    labelName: r.labels?.[0] ? clean(r.labels[0].name) : null,
    labels: (r.labels ?? []).map((l) => clean(l.name)),
    catalogNumber: r.labels?.[0]?.catno && r.labels[0].catno !== 'none' ? r.labels[0].catno : null,
    companies: (r.companies ?? []).filter((c) => c.entity_type_name).map((c) => ({ role: c.entity_type_name!, name: clean(c.name) })),
    artists: (r.artists ?? []).map((a) => clean(a.name)),
    artworkUrl: r.images?.find((i) => i.type === 'primary')?.uri ?? null,
    tracks: tracks.length ? tracks : undefined,
    platformIds: [{ platform: 'discogs', entity: 'release', externalId: String(r.id), url: `https://www.discogs.com/release/${r.id}`, source: 'discogs' }],
  };
}

/** Find the release by its barcode (UPC/EAN), then read it. */
export async function discogsLookup(secret: DiscogsSecret, q: Query): Promise<SourceResult | null> {
  if (!q.upc) return null;
  const barcode = q.upc.replace(/^0/, '');
  const res = await fetchJson<{ results?: Array<{ id: number; type?: string }> }>(`${BASE}/database/search?type=release&barcode=${encodeURIComponent(barcode)}&per_page=5`, { provider: 'discogs', headers: headers(secret), rateLimit: RL });
  const hit = res?.results?.find((r) => !r.type || r.type === 'release');
  if (!hit) return null;
  const release = await discogsRelease(secret, hit.id);
  return release ? fromDiscogs(release) : null;
}

/** Credits on a release, and on one of its tracks when the title matches. */
export function discogsCredits(r: DgRelease, trackTitle: string | null): Array<{ name: string; role: string }> {
  const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
  const track = trackTitle ? r.tracklist?.find((t) => norm(t.title) === norm(trackTitle)) : undefined;
  const out: Array<{ name: string; role: string }> = [];
  for (const a of r.artists ?? []) out.push({ name: clean(a.anv || a.name), role: 'Main Artist' });
  for (const a of [...(track?.extraartists ?? []), ...(r.extraartists ?? []).filter((x) => !x.tracks || !track || x.tracks.includes(track.position ?? '\0'))]) {
    for (const role of (a.role ?? '').split(',').map((s) => s.replace(/\[.*?\]/g, '').trim()).filter(Boolean)) out.push({ name: clean(a.anv || a.name), role });
  }
  return out;
}
