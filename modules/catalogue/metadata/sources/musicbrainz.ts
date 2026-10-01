import { fetchJson } from '@labelconsole/core/http';
import { normalizeUpc } from '../input';
import type { Query, SourceResult, SourceTrack } from './types';
import { normType } from './types';

/** MusicBrainz: open data, strictly 1 request per second, descriptive User-Agent (set globally). */
const RL = { key: 'musicbrainz', capacity: 1, refillPerSec: 1 };
const BASE = 'https://musicbrainz.org/ws/2';

type Credit = Array<{ name: string; joinphrase?: string; artist?: { name: string } }>;
type MbRelease = {
  id: string;
  title: string;
  date?: string;
  barcode?: string | null;
  'label-info'?: Array<{ 'catalog-number'?: string; label?: { name: string } | null }>;
  'release-group'?: { 'primary-type'?: string };
  'artist-credit'?: Credit;
  media?: Array<{ position: number; tracks?: Array<{ position: number; title: string; length?: number; recording?: { title: string; isrcs?: string[]; length?: number; 'artist-credit'?: Credit } }> }>;
};

const names = (c?: Credit) => (c ?? []).map((a) => a.name);

async function get<T>(path: string) {
  return fetchJson<T>(`${BASE}${path}${path.includes('?') ? '&' : '?'}fmt=json`, { provider: 'musicbrainz', rateLimit: RL, allow404: true, timeoutMs: 20_000 });
}

async function releaseDetail(id: string) {
  return get<MbRelease>(`/release/${id}?inc=labels+recordings+isrcs+artist-credits+release-groups`);
}

function fromRelease(r: MbRelease, isrc?: string | null): SourceResult {
  const tracks: SourceTrack[] = [];
  let match: SourceTrack | undefined;
  for (const m of r.media ?? []) {
    for (const t of m.tracks ?? []) {
      const tr: SourceTrack = { title: t.recording?.title ?? t.title, isrc: t.recording?.isrcs?.[0] ?? null, durationMs: t.length ?? t.recording?.length ?? null, position: tracks.length + 1, explicit: null, artists: names(t.recording?.['artist-credit']) };
      tracks.push(tr);
      if (isrc && t.recording?.isrcs?.includes(isrc)) match = tr;
    }
  }
  return {
    source: 'musicbrainz',
    upc: r.barcode ? normalizeUpc(r.barcode) : null,
    releaseTitle: r.title,
    releaseType: normType(r['release-group']?.['primary-type']),
    releaseDate: r.date ?? null,
    labels: (r['label-info'] ?? []).map((l) => l.label?.name).filter((x): x is string => Boolean(x)),
    labelName: r['label-info']?.[0]?.label?.name ?? null,
    artists: match?.artists.length ? match.artists : names(r['artist-credit']),
    title: match?.title ?? (tracks.length === 1 ? tracks[0].title : null),
    durationMs: match?.durationMs ?? null,
    isrc: match?.isrc ?? (tracks.length === 1 ? tracks[0].isrc : null),
    tracks: tracks.length ? tracks : undefined,
    platformIds: [{ platform: 'musicbrainz', entity: 'release', externalId: r.id, url: `https://musicbrainz.org/release/${r.id}`, source: 'musicbrainz' }],
  };
}

export async function musicbrainzLookup(q: Query): Promise<SourceResult | null> {
  let releaseId: string | null = null;
  let recordingId: string | null = null;
  if (q.upc) {
    const res = await get<{ releases?: Array<{ id: string; score?: number }> }>(`/release/?query=barcode:${q.upc.replace(/^0/, '')}%20OR%20barcode:${q.upc}&limit=3`);
    releaseId = res?.releases?.[0]?.id ?? null;
  }
  if (!releaseId && q.isrc) {
    const res = await get<{ recordings?: Array<{ id: string; releases?: Array<{ id: string; status?: string; date?: string }> }> }>(`/isrc/${q.isrc}?inc=releases`);
    const rec = res?.recordings?.[0];
    recordingId = rec?.id ?? null;
    // Prefer the earliest official release containing the recording.
    const rels = (rec?.releases ?? []).filter((r) => r.status !== 'Bootleg').sort((a, b) => (a.date ?? '9999').localeCompare(b.date ?? '9999'));
    releaseId = rels[0]?.id ?? null;
  }
  if (!releaseId) return null;
  const detail = await releaseDetail(releaseId);
  if (!detail) return null;
  const out = fromRelease(detail, q.isrc);
  if (recordingId) out.platformIds!.push({ platform: 'musicbrainz', entity: 'track', externalId: recordingId, url: `https://musicbrainz.org/recording/${recordingId}`, source: 'musicbrainz' });
  return out;
}

export async function musicbrainzSearch(title: string, artist: string | null): Promise<{ isrc: string | null; title: string } | null> {
  const query = `recording:"${title.replace(/"/g, '')}"${artist ? ` AND artist:"${artist.replace(/"/g, '')}"` : ''}`;
  const res = await get<{ recordings?: Array<{ title: string; score?: number; isrcs?: string[] }> }>(`/recording/?query=${encodeURIComponent(query)}&limit=5`);
  const best = res?.recordings?.find((r) => (r.score ?? 0) >= 80 && r.isrcs?.length) ?? res?.recordings?.[0];
  return best ? { isrc: best.isrcs?.[0] ?? null, title: best.title } : null;
}
