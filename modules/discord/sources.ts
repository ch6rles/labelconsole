import { fetchJson } from '@labelconsole/core/http';

/**
 * Public lookups for /artist and /label: Deezer (artists, fans, releases) and
 * MusicBrainz (country, type, dates, label codes). They share the catalogue
 * sources' rate-limit buckets, so every process stays within each API's limits.
 */
const DEEZER = { key: 'deezer', capacity: 50, refillPerSec: 10 };
const MB = { key: 'musicbrainz', capacity: 1, refillPerSec: 1 };

const deezer = <T>(path: string) => fetchJson<T & { error?: unknown }>(`https://api.deezer.com${path}`, { provider: 'deezer', rateLimit: DEEZER, allow404: true }).then((r) => (r && !r.error ? r : null));
const mb = <T>(path: string) => fetchJson<T>(`https://musicbrainz.org/ws/2${path}${path.includes('?') ? '&' : '?'}fmt=json`, { provider: 'musicbrainz', rateLimit: MB, allow404: true, timeoutMs: 20_000 });

const norm = (s: string | null | undefined) =>
  (s ?? '')
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();

export type DeezerArtist = { id: number; name: string; link?: string; picture_xl?: string; picture_big?: string; nb_fan?: number; nb_album?: number };

export async function searchArtists(q: string) {
  return (await deezer<{ data?: DeezerArtist[] }>(`/search/artist?q=${encodeURIComponent(q)}&limit=6`))?.data ?? [];
}

export const deezerArtist = (id: string) => (/^\d{1,20}$/.test(id) ? deezer<DeezerArtist>(`/artist/${id}`) : Promise.resolve(null));

export async function deezerArtistReleases(id: number | string, limit = 5) {
  const res = await deezer<{ data?: Array<{ id: number; title: string; record_type?: string; release_date?: string; link?: string }> }>(`/artist/${id}/albums?limit=50`);
  return (res?.data ?? []).sort((a, b) => (b.release_date ?? '').localeCompare(a.release_date ?? '')).slice(0, limit);
}

/** The artist to show without asking: the only result, or the one whose name matches exactly (the most followed if several do). */
export function pickArtist(results: DeezerArtist[], q: string): DeezerArtist | 'ambiguous' | null {
  if (!results.length) return null;
  const exact = results.filter((a) => norm(a.name) === norm(q));
  if (exact.length === 1) return exact[0];
  if (results.length === 1) return results[0];
  return 'ambiguous';
}

type MbLifeSpan = { begin?: string | null; end?: string | null };
export type MbArtist = { id: string; name: string; score?: number; type?: string; country?: string; area?: { name: string }; 'life-span'?: MbLifeSpan; disambiguation?: string };

/** MusicBrainz details for an artist with exactly this name (the best scored, if several). */
export async function musicbrainzArtist(name: string): Promise<MbArtist | null> {
  const res = await mb<{ artists?: MbArtist[] }>(`/artist/?query=${encodeURIComponent(`artist:"${name.replace(/"/g, '')}"`)}&limit=5`);
  return res?.artists?.find((a) => norm(a.name) === norm(name) && (a.score ?? 0) >= 90) ?? null;
}

export type MbLabel = { id: string; name: string; score?: number; type?: string; country?: string; area?: { name: string }; 'label-code'?: number; 'life-span'?: MbLifeSpan; disambiguation?: string };

export async function searchLabels(q: string) {
  return (await mb<{ labels?: MbLabel[] }>(`/label/?query=${encodeURIComponent(`label:"${q.replace(/"/g, '')}"`)}&limit=6`))?.labels ?? [];
}

export const musicbrainzLabel = (id: string) => (/^[0-9a-f-]{36}$/.test(id) ? mb<MbLabel>(`/label/${id}`) : Promise.resolve(null));

export async function labelReleaseCount(id: string) {
  const res = await mb<{ 'release-count'?: number }>(`/release?label=${id}&limit=1`);
  return res?.['release-count'] ?? null;
}

export function pickLabel(results: MbLabel[], q: string): MbLabel | 'ambiguous' | null {
  const exact = results.filter((l) => norm(l.name) === norm(q));
  if (exact.length === 1) return exact[0];
  if (exact.length > 1) return 'ambiguous';
  return results.length ? 'ambiguous' : null;
}
