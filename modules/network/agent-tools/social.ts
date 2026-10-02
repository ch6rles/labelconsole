import { z } from 'zod';
import { apifyFor } from '@labelconsole/core/apify';
import { isTransient, ProviderError } from '@labelconsole/core/errors';
import { clip, defineTool, type ToolContext } from '@labelconsole/core/tools';
import { recordUsage } from '@labelconsole/core/usage';
import * as svc from '../service';
import { analyzeCreator, type CreatorAnalysis } from '../social/analysis';
import { instagramCreator, instagramPostAuthors, tiktokCreators, youtubeCreators, type SocialCreator, type SocialPlatform, type SocialPost } from '../social/parse';

/**
 * Social research through Apify scrapers. Each tool is tagged with its
 * platform so a run limited to, say, TikTok never sees the others. Results
 * are normalised and analysed before they reach the model; raw scraper items
 * never do. Every result is billed by Apify, so limits stay small.
 */
const ACTORS = { tiktok: 'clockworks/tiktok-scraper', instagram: 'apify/instagram-scraper', youtube: 'streamers/youtube-scraper' } as const;
const NO_KEY = 'No Apify token is configured for this label. Add one under Settings → Integrations → Apify, or set APIFY_API_TOKEN for the platform.';
const SCRAPE_TIMEOUT_MS = 300_000;

async function scrape(t: ToolContext, platform: SocialPlatform, input: Record<string, unknown>, maxItems: number): Promise<unknown[]> {
  const client = await t.withOrg((ctx) => apifyFor(ctx));
  if (!client) throw new ProviderError('apify', NO_KEY, { transient: false });
  try {
    return await client.run(ACTORS[platform], input, { maxItems, timeoutSecs: 240, signal: t.signal });
  } catch (err) {
    // A scrape is paid per result: report a slow or failed run instead of letting the runtime repeat it.
    if (isTransient(err)) throw new ProviderError('apify', `The ${platform} scrape did not finish (${(err as Error).message}). Try again with a smaller limit, or later.`, { transient: false });
    throw err;
  } finally {
    if (client.results) await t.withOrg((ctx) => recordUsage(ctx, 'apify_results', client.results));
  }
}

/** "@name", "name" or a profile link → the bare handle, or null when it is not one. */
export function handleFrom(platform: SocialPlatform, raw: string): string | null {
  const h = svc.normalizeHandle(raw);
  if (platform === 'youtube' && /youtube\.com\/(channel|c|user)\//i.test(raw)) return null;
  return /^[a-z0-9._-]{1,60}$/.test(h) ? h : null;
}

/** Channel links for the YouTube scraper: @handles, or /channel/ and /c/ links as given. */
function youtubeChannelUrl(raw: string): string | null {
  const s = raw.trim();
  const link = s.match(/^(?:https?:\/\/)?(?:www\.|m\.)?youtube\.com\/((?:channel\/UC[\w-]{10,40})|(?:c|user)\/[\w.-]{1,100}|@[\w.-]{1,100})/i);
  if (link) return `https://www.youtube.com/${link[1]}`;
  const h = handleFrom('youtube', s);
  return h ? `https://www.youtube.com/@${h}` : null;
}

type Opts = { includeImages: boolean; posts: number; priceUsd?: number };

function postView(p: SocialPost, o: Opts) {
  return {
    url: p.url,
    postedAt: p.postedAt?.slice(0, 10) ?? null,
    kind: p.kind,
    views: p.views,
    likes: p.likes,
    comments: p.comments,
    shares: p.shares,
    sponsored: p.sponsored || undefined,
    pinned: p.pinned || undefined,
    caption: p.caption ? clip(p.caption, 100) : null,
    sound: p.sound ?? undefined,
    ...(o.includeImages && p.thumbnailUrl ? { thumbnailUrl: p.thumbnailUrl } : {}),
  };
}

type InNetwork = { contactId: string; name: string; stage: string; rate: string | null; doNotContact: boolean } | null;

async function networkMatches(t: ToolContext, platform: SocialPlatform, creators: SocialCreator[]) {
  const found = await t.withOrg((ctx) => svc.contactsByHandles(ctx, platform, creators.map((c) => c.handle)));
  return (c: SocialCreator): InNetwork => {
    const row = found.get(c.handle);
    if (!row) return null;
    const a = svc.contactForAgent(row);
    return { contactId: a.id, name: a.name, stage: a.stage, rate: a.rate, doNotContact: a.gone || a.stage === 'do_not_contact' };
  };
}

function creatorSummary(c: SocialCreator, inNetwork: InNetwork, o: Opts) {
  return {
    platform: c.platform,
    handle: c.handle,
    name: c.name,
    url: c.url,
    verified: c.verified,
    followers: c.followers,
    totalLikes: c.totalLikes ?? undefined,
    totalViews: c.totalViews ?? undefined,
    totalPosts: c.totalPosts,
    bio: c.bio ? clip(c.bio, 160) : null,
    category: c.category ?? undefined,
    externalUrl: c.externalUrl ?? undefined,
    private: c.private || undefined,
    inNetwork,
    ...(o.includeImages && c.avatarUrl ? { avatarUrl: c.avatarUrl } : {}),
  };
}

function profileResult(c: SocialCreator, inNetwork: InNetwork, o: Opts) {
  const analysis: CreatorAnalysis = analyzeCreator(c, { priceUsd: o.priceUsd });
  return { ...creatorSummary(c, inNetwork, o), analysis, recentPosts: c.posts.slice(0, o.posts).map((p) => postView(p, o)) };
}

async function profiles(t: ToolContext, platform: SocialPlatform, creators: SocialCreator[], asked: string[], o: Opts) {
  const match = await networkMatches(t, platform, creators);
  // With several accounts in one call, fewer posts each keeps the result readable.
  const perCreator = { ...o, posts: creators.length > 2 ? 6 : 10 };
  const missing = asked.filter((h) => !creators.some((c) => c.handle === h || c.url.toLowerCase().includes(h)));
  return {
    creators: creators.map((c) => profileResult(c, match(c), perCreator)),
    ...(missing.length ? { notFound: missing, note: 'No posts came back for these accounts: they may not exist, be private, or have no posts.' } : {}),
  };
}

const IMAGES = z.boolean().default(false).describe('Include profile picture and post thumbnail links, for saving them to Drive with drive_save_images');
const PRICE = z.number().min(0).max(1_000_000).optional().describe('Quoted price in USD for one promo post, to compute cost per 1,000 views');
const HANDLES = (platform: string) => z.array(z.string().trim().min(1).max(200)).min(1).max(5).describe(`${platform} handles or profile links, up to 5 per call`);

export const tools = [
  /* ------------------------------------------------------------ TikTok -- */
  defineTool({
    name: 'social_tiktok_search',
    module: 'network',
    platform: 'tiktok',
    description:
      'Search TikTok. find="creators" matches account names and returns accounts with followers and total likes (it does not rank by activity, so it often includes accounts that stopped posting); find="videos" returns matching videos (sort by relevance, most liked or latest; filter to the last day, week, month or months) with their authors, which is the way to find who is active and getting views now; find="hashtag" returns videos under a hashtag with their authors. Accounts already in the network are marked. Use social_tiktok_profile to judge a creator before recommending them. Billed per result.',
    input: z.object({
      query: z.string().trim().min(2).max(100),
      find: z.enum(['creators', 'videos', 'hashtag']).default('creators'),
      period: z.enum(['any', 'day', 'week', 'month', '3months', '6months']).default('any').describe('videos only'),
      sort: z.enum(['relevant', 'most_liked', 'latest']).default('relevant').describe('videos only'),
      limit: z.number().int().min(1).max(30).default(10),
      includeImages: IMAGES,
    }),
    permission: 'network:read',
    risk: 'read',
    idempotent: true,
    timeoutMs: SCRAPE_TIMEOUT_MS,
    preview: (i) => `Search TikTok ${i.find} for "${i.query}"`,
    execute: async (t, i) => {
      const input =
        i.find === 'creators'
          ? { searchQueries: [i.query], searchSection: '/user', maxProfilesPerQuery: i.limit, resultsPerPage: 1 }
          : i.find === 'videos'
            ? {
                searchQueries: [i.query],
                searchSection: '/video',
                resultsPerPage: i.limit,
                videoSearchSorting: { relevant: 'MOST_RELEVANT', most_liked: 'MOST_LIKED', latest: 'LATEST' }[i.sort],
                videoSearchDateFilter: { any: 'ALL_TIME', day: 'PAST_24_HOURS', week: 'PAST_WEEK', month: 'PAST_MONTH', '3months': 'LAST_3_MONTHS', '6months': 'LAST_6_MONTHS' }[i.period],
              }
            : { hashtags: [i.query.replace(/^#/, '').replace(/\s+/g, '')], resultsPerPage: i.limit };
      const creators = tiktokCreators(await scrape(t, 'tiktok', input, i.limit));
      const match = await networkMatches(t, 'tiktok', creators);
      const o = { includeImages: i.includeImages, posts: 3 };
      return {
        query: i.query,
        find: i.find,
        creators: creators.map((c) => ({ ...creatorSummary(c, match(c), o), ...(i.find === 'creators' ? {} : { matchingVideos: c.posts.slice(0, 3).map((p) => postView(p, o)) }) })),
      };
    },
  }),
  defineTool({
    name: 'social_tiktok_profile',
    module: 'network',
    platform: 'tiktok',
    description:
      "Look at TikTok creators' profiles the way a person would before paying for a promo: followers, their latest videos with views, likes, comments, shares and sounds, plus an analysis (last post, posts per week, median views, engagement, views versus followers, whether recent videos are rising or cooling, breakout hits, paid partnerships, and cost per 1,000 views if you give a price). Up to 5 accounts per call. Billed per video.",
    input: z.object({ handles: HANDLES('TikTok'), posts: z.number().int().min(6).max(24).default(12).describe('Latest videos to read per account'), priceUsd: PRICE, includeImages: IMAGES }),
    permission: 'network:read',
    risk: 'read',
    idempotent: true,
    timeoutMs: SCRAPE_TIMEOUT_MS,
    preview: (i) => `Read TikTok profiles: ${i.handles.join(', ')}`,
    execute: async (t, i) => {
      const handles = i.handles.map((h) => handleFrom('tiktok', h));
      if (handles.some((h) => !h)) return { error: `Not a TikTok handle: ${i.handles.filter((_, n) => !handles[n]).join(', ')}` };
      const asked = handles as string[];
      const items = await scrape(t, 'tiktok', { profiles: asked, resultsPerPage: i.posts, profileSorting: 'latest', profileScrapeSections: ['videos'], excludePinnedPosts: false }, i.posts * asked.length);
      return profiles(t, 'tiktok', tiktokCreators(items), asked, { includeImages: i.includeImages, posts: 10, priceUsd: i.priceUsd });
    },
  }),

  /* --------------------------------------------------------- Instagram -- */
  defineTool({
    name: 'social_instagram_search',
    module: 'network',
    platform: 'instagram',
    description:
      'Search Instagram. find="hashtag" (best for finding people active in a niche, e.g. "funkedit") returns the accounts behind the latest posts under that hashtag, with likes and dates but without follower counts; find="accounts" searches account names and returns profiles with followers and a quick analysis of their latest posts (name matching is loose, so check relevance). Accounts already in the network are marked. Billed per result.',
    input: z.object({
      query: z.string().trim().min(2).max(100),
      find: z.enum(['hashtag', 'accounts']).default('hashtag'),
      limit: z.number().int().min(1).max(30).default(15).describe('Posts to scan (hashtag) or accounts to return (accounts)'),
      includeImages: IMAGES,
    }),
    permission: 'network:read',
    risk: 'read',
    idempotent: true,
    timeoutMs: SCRAPE_TIMEOUT_MS,
    preview: (i) => `Search Instagram ${i.find === 'hashtag' ? `#${i.query.replace(/^#/, '')}` : `accounts for "${i.query}"`}`,
    execute: async (t, i) => {
      const o = { includeImages: i.includeImages, posts: 3 };
      if (i.find === 'hashtag') {
        const tag = i.query.replace(/^#/, '').replace(/\s+/g, '').toLowerCase();
        if (!/^[\p{L}\p{N}_]{1,100}$/u.test(tag)) return { error: 'A hashtag can only contain letters, numbers and underscores' };
        const creators = instagramPostAuthors(await scrape(t, 'instagram', { directUrls: [`https://www.instagram.com/explore/tags/${encodeURIComponent(tag)}/`], resultsType: 'posts', resultsLimit: i.limit }, i.limit));
        const match = await networkMatches(t, 'instagram', creators);
        return {
          hashtag: tag,
          accounts: creators.map((c) => ({ handle: c.handle, name: c.name, url: c.url, inNetwork: match(c), postsInSample: c.posts.length, posts: c.posts.slice(0, 3).map((p) => postView(p, o)) })),
          note: 'Follower counts and reach need social_instagram_profile.',
        };
      }
      const creators = (await scrape(t, 'instagram', { search: i.query, searchType: 'profile', searchLimit: i.limit, resultsType: 'details' }, i.limit)).map(instagramCreator).filter((c): c is SocialCreator => Boolean(c));
      const match = await networkMatches(t, 'instagram', creators);
      return {
        query: i.query,
        accounts: creators.map((c) => {
          const a = analyzeCreator(c);
          return { ...creatorSummary(c, match(c), o), lastPostDaysAgo: a.lastPostDaysAgo, medianViews: a.medianViews, medianLikes: a.medianLikes, engagementPct: a.engagementPct, momentum: a.momentum.trend };
        }),
      };
    },
  }),
  defineTool({
    name: 'social_instagram_profile',
    module: 'network',
    platform: 'instagram',
    description:
      "Look at Instagram accounts' profiles before paying for a promo: followers, bio, category, their latest 12 posts and reels with likes, comments and views, plus an analysis (last post, posting rate, median views and likes, engagement, views versus followers, rising or cooling, paid partnerships, cost per 1,000 views if you give a price). Up to 5 accounts per call. Billed per account.",
    input: z.object({ handles: HANDLES('Instagram'), priceUsd: PRICE, includeImages: IMAGES }),
    permission: 'network:read',
    risk: 'read',
    idempotent: true,
    timeoutMs: SCRAPE_TIMEOUT_MS,
    preview: (i) => `Read Instagram profiles: ${i.handles.join(', ')}`,
    execute: async (t, i) => {
      const handles = i.handles.map((h) => handleFrom('instagram', h));
      if (handles.some((h) => !h)) return { error: `Not an Instagram handle: ${i.handles.filter((_, n) => !handles[n]).join(', ')}` };
      const asked = handles as string[];
      const items = await scrape(t, 'instagram', { directUrls: asked.map((h) => `https://www.instagram.com/${h}/`), resultsType: 'details' }, asked.length);
      const creators = items.map(instagramCreator).filter((c): c is SocialCreator => Boolean(c));
      return profiles(t, 'instagram', creators, asked, { includeImages: i.includeImages, posts: 10, priceUsd: i.priceUsd });
    },
  }),

  /* ----------------------------------------------------------- YouTube -- */
  defineTool({
    name: 'social_youtube_search',
    module: 'network',
    platform: 'youtube',
    description:
      'Search YouTube videos (sort by relevance, upload date, views or rating; filter to the last hour, day, week, month or year). Returns the matching videos grouped by channel, with subscriber counts. Channels already in the network are marked. Use social_youtube_profile to judge a channel. Billed per result.',
    input: z.object({
      query: z.string().trim().min(2).max(100),
      sort: z.enum(['relevance', 'date', 'views', 'rating']).default('relevance'),
      period: z.enum(['any', 'hour', 'today', 'week', 'month', 'year']).default('any'),
      limit: z.number().int().min(1).max(30).default(10),
      includeImages: IMAGES,
    }),
    permission: 'network:read',
    risk: 'read',
    idempotent: true,
    timeoutMs: SCRAPE_TIMEOUT_MS,
    preview: (i) => `Search YouTube for "${i.query}"`,
    execute: async (t, i) => {
      const input: Record<string, unknown> = { searchQueries: [i.query], maxResults: i.limit, maxResultsShorts: 0, maxResultStreams: 0, sortingOrder: i.sort };
      if (i.period !== 'any') input.dateFilter = i.period;
      const creators = youtubeCreators(await scrape(t, 'youtube', input, i.limit));
      const match = await networkMatches(t, 'youtube', creators);
      const o = { includeImages: i.includeImages, posts: 3 };
      return { query: i.query, channels: creators.map((c) => ({ ...creatorSummary(c, match(c), o), matchingVideos: c.posts.slice(0, 3).map((p) => postView(p, o)) })) };
    },
  }),
  defineTool({
    name: 'social_youtube_profile',
    module: 'network',
    platform: 'youtube',
    description:
      "Look at YouTube channels before paying for a promo: subscribers, total views, their newest videos (and Shorts if asked) with views, likes and comments, plus an analysis (last upload, upload rate, median views, engagement, views versus subscribers, rising or cooling, paid promotions, cost per 1,000 views if you give a price). Up to 5 channels per call (@handles or channel links). Billed per video.",
    input: z.object({ channels: HANDLES('YouTube'), videos: z.number().int().min(4).max(20).default(10).describe('Newest videos to read per channel'), includeShorts: z.boolean().default(true), priceUsd: PRICE, includeImages: IMAGES }),
    permission: 'network:read',
    risk: 'read',
    idempotent: true,
    timeoutMs: SCRAPE_TIMEOUT_MS,
    preview: (i) => `Read YouTube channels: ${i.channels.join(', ')}`,
    execute: async (t, i) => {
      const urls = i.channels.map(youtubeChannelUrl);
      if (urls.some((u) => !u)) return { error: `Not a YouTube channel: ${i.channels.filter((_, n) => !urls[n]).join(', ')}` };
      const shorts = i.includeShorts ? Math.ceil(i.videos / 2) : 0;
      const items = await scrape(t, 'youtube', { startUrls: (urls as string[]).map((url) => ({ url })), maxResults: i.videos, maxResultsShorts: shorts, maxResultStreams: 0, sortVideosBy: 'NEWEST' }, (i.videos + shorts) * urls.length);
      const creators = youtubeCreators(items);
      const asked = (urls as string[]).map((u) => u.replace(/^https:\/\/www\.youtube\.com\/@?/, '').toLowerCase());
      return profiles(t, 'youtube', creators, asked, { includeImages: i.includeImages, posts: 10, priceUsd: i.priceUsd });
    },
  }),
];
