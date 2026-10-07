import { fetchJson } from '@labelconsole/core/http';
import { acquire } from '@labelconsole/core/ratelimit';
import { YOUTUBE_PLATFORMS, type Snapshot, type StreamSourceAdapter, type TrackRef } from './types';

/**
 * YouTube Data API v3. Polling uses videos.list only: 1 quota unit per call of
 * up to 50 IDs. search.list (100 units) is used by the resolver, once per
 * track, and never while polling. Quota is metered per API key with a shared
 * Redis token bucket so every worker respects the daily allowance.
 */
const API = 'https://www.googleapis.com/youtube/v3';
export const DAILY_QUOTA = 10_000;
/** Leave headroom for metadata lookups and manual checks. */
const POLL_BUDGET = 9_000;
const SEARCH_COST = 100;

export type YouTubeSecret = { apiKey: string };

type VideoItem = { id: string; snippet?: { title: string; channelTitle: string; channelId: string; description?: string; publishedAt?: string }; statistics?: { viewCount?: string }; contentDetails?: { duration?: string } };

function quotaKey(apiKey: string) {
  // Keyed by a short hash of the key: quota belongs to the Google project, not the org.
  let h = 0;
  for (const c of apiKey) h = (h * 31 + c.charCodeAt(0)) | 0;
  return `yt-quota:${(h >>> 0).toString(36)}`;
}

async function spend(apiKey: string, units: number, signal?: AbortSignal) {
  await acquire(quotaKey(apiKey), { capacity: POLL_BUDGET, refillPerSec: POLL_BUDGET / 86_400 }, { cost: units, maxWaitMs: 5_000, signal });
}

export async function videosList(apiKey: string, ids: string[], parts: string[], signal?: AbortSignal): Promise<VideoItem[]> {
  const out: VideoItem[] = [];
  for (let i = 0; i < ids.length; i += 50) {
    const batch = ids.slice(i, i + 50);
    await spend(apiKey, 1, signal);
    const res = await fetchJson<{ items: VideoItem[] }>(`${API}/videos?part=${parts.join(',')}&id=${batch.join(',')}&maxResults=50&key=${encodeURIComponent(apiKey)}`, { provider: 'youtube', signal, timeoutMs: 20_000 });
    out.push(...(res?.items ?? []));
  }
  return out;
}

export type SearchCandidate = { videoId: string; title: string; channelTitle: string; channelId: string; durationSec: number | null; viewCount: number | null; publishedAt: string | null; description: string };

/** One search.list call (100 units) plus one videos.list for durations (1 unit). */
export async function searchVideos(apiKey: string, q: string, signal?: AbortSignal): Promise<SearchCandidate[]> {
  await spend(apiKey, SEARCH_COST, signal);
  const res = await fetchJson<{ items: Array<{ id: { videoId?: string } }> }>(`${API}/search?part=id&type=video&maxResults=10&q=${encodeURIComponent(q)}&key=${encodeURIComponent(apiKey)}`, { provider: 'youtube', signal });
  const ids = (res?.items ?? []).map((i) => i.id.videoId).filter((x): x is string => Boolean(x));
  if (ids.length === 0) return [];
  const details = await videosList(apiKey, ids, ['snippet', 'contentDetails', 'statistics'], signal);
  return ids
    .map((id) => details.find((d) => d.id === id))
    .filter((d): d is VideoItem => Boolean(d?.snippet))
    .map((d) => ({
      videoId: d.id,
      title: d.snippet!.title,
      channelTitle: d.snippet!.channelTitle,
      channelId: d.snippet!.channelId,
      description: d.snippet!.description ?? '',
      publishedAt: d.snippet!.publishedAt ?? null,
      durationSec: parseIsoDuration(d.contentDetails?.duration),
      viewCount: d.statistics?.viewCount != null ? Number(d.statistics.viewCount) : null,
    }));
}

/** "PT3M34S" → 214 */
export function parseIsoDuration(d: string | undefined): number | null {
  const m = d?.match(/^P(?:(\d+)D)?T?(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?$/);
  if (!m) return null;
  return Number(m[1] ?? 0) * 86400 + Number(m[2] ?? 0) * 3600 + Number(m[3] ?? 0) * 60 + Number(m[4] ?? 0);
}

export const youtubeAdapter: StreamSourceAdapter<YouTubeSecret> = {
  id: 'youtube-data-api',
  async fetch(secret, refs, opts) {
    const yt = refs.filter((r) => YOUTUBE_PLATFORMS.includes(r.platform));
    const items = await videosList(secret.apiKey, [...new Set(yt.map((r) => r.externalId))], ['statistics'], opts?.signal);
    const capturedAt = new Date();
    const byId = new Map(items.map((i) => [i.id, i]));
    const snapshots: Snapshot[] = [];
    const missing: TrackRef[] = [];
    for (const r of yt) {
      const v = byId.get(r.externalId)?.statistics?.viewCount;
      // A video that disappeared or hides its count is reported, never recorded as zero.
      if (v == null) missing.push(r);
      else snapshots.push({ trackId: r.trackId, platform: r.platform, source: 'youtube-data-api', externalId: r.externalId, capturedAt, count: Number(v) });
    }
    return { snapshots, missing };
  },
};

/* ------------------------------------------------------------ matching -- */

const norm = (s: string) =>
  s
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/\s*[([](official|lyric|lyrics|audio|music|visuali[sz]er|video|hd|4k|explicit|clean)[^)\]]*[)\]]/g, '')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();

export type MatchVerdict = { videoId: string; variant: 'topic' | 'official'; confidence: number; reasons: string[] };

/**
 * Score search results for a track. The Topic channel art track (the YouTube
 * Music upload, "Provided to YouTube by <distributor>") is preferred, then the
 * artist's official video. Duration within a few seconds is strong evidence.
 */
export function scoreCandidates(track: { title: string; artists: string[]; durationMs: number | null }, candidates: SearchCandidate[]): MatchVerdict[] {
  const title = norm(track.title);
  const artists = track.artists.map(norm).filter(Boolean);
  const out: MatchVerdict[] = [];
  for (const c of candidates) {
    const reasons: string[] = [];
    let score = 0;
    const isTopic = / - topic$/i.test(c.channelTitle);
    const channel = norm(c.channelTitle.replace(/ - topic$/i, '').replace(/vevo$/i, ''));
    const vtitle = norm(c.title);
    const artistOnChannel = artists.some((a) => channel === a || channel.startsWith(a) || a.startsWith(channel));
    const titleExact = vtitle === title || vtitle === `${artists[0]} ${title}` || vtitle.endsWith(` ${title}`);
    const titleContains = vtitle.includes(title);
    if (!titleContains) continue;
    if (isTopic && artistOnChannel) {
      score += 0.6;
      reasons.push('Topic channel of the artist');
    } else if (artistOnChannel) {
      score += 0.4;
      reasons.push('Artist channel');
    } else if (artists.some((a) => vtitle.includes(a))) {
      score += 0.15;
      reasons.push('Artist named in title');
    } else continue;
    if (titleExact) {
      score += 0.25;
      reasons.push('Title matches');
    } else {
      score += 0.1;
      reasons.push('Title contains track title');
    }
    if (isTopic && /provided to youtube by/i.test(c.description)) {
      score += 0.05;
      reasons.push('Distributor upload');
    }
    if (track.durationMs && c.durationSec != null) {
      const diff = Math.abs(c.durationSec - track.durationMs / 1000);
      if (diff <= 3) {
        score += 0.15;
        reasons.push('Same length');
      } else if (diff > 20 && isTopic) {
        score -= 0.3;
        reasons.push(`Length differs by ${Math.round(diff)}s`);
      }
    }
    if (/\b(remix|live|cover|sped up|slowed|nightcore|karaoke|instrumental)\b/.test(vtitle) && !/\b(remix|live|instrumental)\b/.test(title)) {
      // A remix or live take is a different recording: never confident, whatever else matches.
      score -= 0.6;
      reasons.push('Looks like a different version');
    }
    out.push({ videoId: c.videoId, variant: isTopic ? 'topic' : 'official', confidence: Math.max(0, Math.min(1, Number(score.toFixed(3)))), reasons });
  }
  // Best topic match first, then best official video. On a tie (e.g. a subtitled re-post on the artist's own
  // channel), the video with more views is the canonical one.
  const views = new Map(candidates.map((c) => [c.videoId, c.viewCount ?? 0]));
  return out.sort((a, b) => (a.variant === b.variant ? b.confidence - a.confidence || views.get(b.videoId)! - views.get(a.videoId)! : a.variant === 'topic' ? -1 : 1));
}

/** Confidence at or above this is confirmed automatically; between REVIEW and AUTO goes to the review queue. */
export const AUTO_CONFIRM = 0.85;
export const REVIEW = 0.5;

/** youtu.be/x, youtube.com/watch?v=x, music.youtube.com/watch?v=x, or a bare 11-char ID. */
export function parseVideoId(input: string): string | null {
  const s = input.trim();
  if (/^[A-Za-z0-9_-]{11}$/.test(s)) return s;
  try {
    const u = new URL(s);
    if (u.hostname === 'youtu.be') return u.pathname.slice(1, 12) || null;
    if (/(^|\.)youtube\.com$/.test(u.hostname)) {
      const v = u.searchParams.get('v') ?? u.pathname.match(/^\/(?:shorts|embed|live)\/([A-Za-z0-9_-]{11})/)?.[1];
      return v && /^[A-Za-z0-9_-]{11}$/.test(v) ? v : null;
    }
  } catch {
    /* not a URL */
  }
  return null;
}
