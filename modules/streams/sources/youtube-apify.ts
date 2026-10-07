import type { ApifyClient } from '@labelconsole/core/apify';
import type { SearchCandidate } from './youtube';
import { YOUTUBE_PLATFORMS, type Snapshot, type TrackRef } from './types';

/**
 * YouTube without a Data API key: the same public view counts, read through
 * an Apify scraper and billed per video. Used only when the label has an
 * Apify token and no YouTube key; the free official API stays the first
 * choice. Each video is read at most once a day (see the poll job), which
 * is enough for daily plays and keeps the bill predictable.
 *
 * A song's YouTube Music plays are the views of its art track (the "Artist -
 * Topic" upload, "Provided to YouTube by <distributor>"); the official video
 * is counted separately. Matching prefers the art track, as with the API.
 */
export const YOUTUBE_ACTOR = 'apidojo/youtube-scraper';
const MAX_PER_RUN = 200;

type Obj = Record<string, unknown>;
const obj = (v: unknown): Obj => (v && typeof v === 'object' && !Array.isArray(v) ? (v as Obj) : {});
const str = (v: unknown) => (typeof v === 'string' && v.trim() ? v.trim() : null);
const count = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) && v >= 0 ? v : typeof v === 'string' && /^\d+$/.test(v) ? Number(v) : null);
const videoId = (v: unknown) => {
  const id = str(v);
  return id && /^[A-Za-z0-9_-]{11}$/.test(id) ? id : null;
};

/** A scraped video as a search candidate, in the shape the matcher scores. */
export function candidateFrom(item: unknown): SearchCandidate | null {
  const v = obj(item);
  const id = videoId(v.id);
  if (!id || v.type === 'channel' || v.type === 'playlist') return null;
  const channel = obj(v.channel);
  return {
    videoId: id,
    title: str(v.title) ?? '',
    channelTitle: str(channel.name) ?? str(v.channel) ?? '',
    channelId: str(channel.id) ?? '',
    durationSec: count(v.duration),
    viewCount: count(v.views),
    publishedAt: str(v.publishDate),
    description: str(v.description) ?? '',
  };
}

/** View counts for these videos; videos that are gone or hide their count are left out. */
export async function videoViews(client: ApifyClient, ids: string[], signal?: AbortSignal): Promise<Map<string, number>> {
  const out = new Map<string, number>();
  const unique = [...new Set(ids)];
  for (let i = 0; i < unique.length; i += MAX_PER_RUN) {
    const batch = unique.slice(i, i + MAX_PER_RUN);
    const items = await client.run(YOUTUBE_ACTOR, { startUrls: batch.map((id) => `https://www.youtube.com/watch?v=${id}`), maxItems: batch.length }, { maxItems: batch.length, signal });
    for (const item of items) {
      const v = obj(item);
      const id = videoId(v.id);
      const views = count(v.views);
      if (id && views != null && (v.status === undefined || v.status === 'OK')) out.set(id, views);
    }
  }
  return out;
}

/** Ten results for a query, for the matcher (about the cost of ten reads). */
export async function searchVideosApify(client: ApifyClient, q: string, signal?: AbortSignal): Promise<SearchCandidate[]> {
  const items = await client.run(YOUTUBE_ACTOR, { keywords: [q], maxItems: 10 }, { maxItems: 10, signal });
  return items.map(candidateFrom).filter((c): c is SearchCandidate => Boolean(c));
}

export async function fetchViewsApify(client: ApifyClient, refs: TrackRef[], signal?: AbortSignal): Promise<{ snapshots: Snapshot[]; missing: TrackRef[] }> {
  const yt = refs.filter((r) => YOUTUBE_PLATFORMS.includes(r.platform));
  const views = await videoViews(client, yt.map((r) => r.externalId), signal);
  const capturedAt = new Date();
  const snapshots: Snapshot[] = [];
  const missing: TrackRef[] = [];
  for (const r of yt) {
    const v = views.get(r.externalId);
    if (v == null) missing.push(r);
    else snapshots.push({ trackId: r.trackId, platform: r.platform, source: 'youtube-scraper', externalId: r.externalId, capturedAt, count: v });
  }
  return { snapshots, missing };
}
