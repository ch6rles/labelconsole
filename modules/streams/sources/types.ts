import type { StreamSource } from '../schema';

/** A track the tracker polls on one platform, by that platform's ID. */
export type TrackRef = { trackId: string; platform: string; externalId: string };

/** One reading from an adapter. Cumulative counts for polled sources; period totals for statements. */
export type Snapshot = { trackId: string; platform: string; source: StreamSource; externalId: string | null; capturedAt: Date; count: number };

/**
 * Every stream data source implements this. `fetch` makes outbound calls only
 * and never touches the database, so adapters are testable with recorded responses.
 */
export interface StreamSourceAdapter<Secret = unknown> {
  readonly id: StreamSource;
  fetch(secret: Secret, refs: TrackRef[], opts?: { signal?: AbortSignal; orgId?: string }): Promise<{ snapshots: Snapshot[]; missing: TrackRef[] }>;
}

/** Platform slugs used across snapshots, rollups and charts. */
export function platformSlug(source: string): string {
  const s = source.trim().toLowerCase();
  if (s.includes('spotify')) return 'spotify';
  if (s.includes('apple') || s.includes('itunes')) return 'apple_music';
  if (s.includes('youtube')) return 'youtube';
  if (s.includes('amazon')) return 'amazon_music';
  if (s.includes('deezer')) return 'deezer';
  if (s.includes('tidal')) return 'tidal';
  if (s.includes('tiktok') || s.includes('resso')) return 'tiktok';
  if (s.includes('soundcloud')) return 'soundcloud';
  if (s.includes('pandora')) return 'pandora';
  return s.replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, '') || 'other';
}

export const PLATFORM_LABEL: Record<string, string> = {
  youtube: 'YouTube',
  spotify: 'Spotify',
  apple_music: 'Apple Music',
  amazon_music: 'Amazon Music',
  deezer: 'Deezer',
  tidal: 'Tidal',
  tiktok: 'TikTok',
  soundcloud: 'SoundCloud',
  pandora: 'Pandora',
};

export const SOURCE_LABEL: Record<StreamSource, string> = {
  'youtube-data-api': 'YouTube Data API',
  'licensed-provider': 'Licensed provider',
  'statement-import': 'Distributor statements',
};

export const platformLabel = (p: string) => PLATFORM_LABEL[p] ?? p.replace(/_/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase());
