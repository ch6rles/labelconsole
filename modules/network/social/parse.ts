import { clip, type SocialPlatform } from '@labelconsole/core/tools';

/**
 * Normalises Apify scraper output (TikTok, Instagram, YouTube) into one shape.
 * Items are untrusted JSON: every field is checked, nothing is passed through
 * raw, and long text is cut so a tool result stays small.
 */
export type { SocialPlatform };

export type SocialPost = {
  url: string | null;
  postedAt: string | null;
  kind: 'video' | 'short' | 'reel' | 'image' | 'carousel' | 'live';
  caption: string | null;
  views: number | null;
  likes: number | null;
  comments: number | null;
  shares: number | null;
  saves: number | null;
  durationSec: number | null;
  sponsored: boolean;
  pinned: boolean;
  sound: string | null;
  hashtags: string[];
  thumbnailUrl: string | null;
};

export type SocialCreator = {
  platform: SocialPlatform;
  handle: string;
  name: string | null;
  url: string;
  verified: boolean;
  bio: string | null;
  followers: number | null;
  following: number | null;
  totalPosts: number | null;
  totalLikes: number | null;
  totalViews: number | null;
  avatarUrl: string | null;
  externalUrl: string | null;
  category: string | null;
  private: boolean;
  posts: SocialPost[];
};

type Item = Record<string, unknown>;

const obj = (v: unknown): Item => (v && typeof v === 'object' && !Array.isArray(v) ? (v as Item) : {});
/** Counts are non-negative numbers; anything else (missing, -1 for hidden likes) is unknown. */
const num = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) && v >= 0 ? v : null);
const str = (v: unknown, max = 300): string | null => (typeof v === 'string' && v.trim() ? clip(v.trim(), max) : null);
const httpsUrl = (v: unknown): string | null => {
  const s = str(v, 2000);
  return s && /^https:\/\//i.test(s) ? s : null;
};
const iso = (v: unknown): string | null => {
  if (typeof v === 'number' && v > 0) return new Date(v < 1e12 ? v * 1000 : v).toISOString();
  if (typeof v !== 'string') return null;
  const t = Date.parse(v);
  return Number.isNaN(t) ? null : new Date(t).toISOString();
};
const tags = (v: unknown): string[] =>
  (Array.isArray(v) ? v : [])
    .map((h) => (typeof h === 'string' ? h : str(obj(h).name)))
    .filter((h): h is string => Boolean(h))
    .map((h) => clip(h.replace(/^#/, ''), 60))
    .slice(0, 15);
const handleOf = (v: unknown) => (str(v, 100) ?? '').replace(/^@/, '').toLowerCase();

function groupBy<T>(items: T[], key: (t: T) => string): T[][] {
  const groups = new Map<string, T[]>();
  for (const it of items) {
    const k = key(it);
    if (!k) continue;
    groups.set(k, [...(groups.get(k) ?? []), it]);
  }
  return [...groups.values()];
}

/* ------------------------------------------------------------- TikTok -- */

export function tiktokPost(item: Item): SocialPost {
  const video = obj(item.videoMeta);
  const music = obj(item.musicMeta);
  const sound = str(music.musicName, 100);
  return {
    url: httpsUrl(item.webVideoUrl),
    postedAt: iso(item.createTimeISO) ?? iso(item.createTime),
    kind: item.isSlideshow === true ? 'carousel' : 'video',
    caption: str(item.text, 300),
    views: num(item.playCount),
    likes: num(item.diggCount),
    comments: num(item.commentCount),
    shares: num(item.shareCount),
    saves: num(item.collectCount),
    durationSec: num(video.duration),
    sponsored: item.isSponsored === true || item.isAd === true,
    pinned: item.isPinned === true,
    sound: sound ? `${sound}${str(music.musicAuthor, 80) ? ` · ${str(music.musicAuthor, 80)}` : ''}${music.musicOriginal === true ? ' (original)' : ''}` : null,
    hashtags: tags(item.hashtags),
    thumbnailUrl: httpsUrl(video.coverUrl),
  };
}

function tiktokCreator(author: Item, posts: SocialPost[]): SocialCreator {
  const handle = handleOf(author.name);
  return {
    platform: 'tiktok',
    handle,
    name: str(author.nickName, 120),
    url: httpsUrl(author.profileUrl) ?? `https://www.tiktok.com/@${handle}`,
    verified: author.verified === true,
    bio: str(author.signature, 300),
    followers: num(author.fans),
    following: num(author.following),
    totalPosts: num(author.video),
    totalLikes: num(author.heart),
    totalViews: null,
    avatarUrl: httpsUrl(author.avatar),
    externalUrl: httpsUrl(obj(author.bioLink).link) ?? httpsUrl(author.bioLink),
    category: null,
    private: author.privateAccount === true,
    posts,
  };
}

/** TikTok returns videos with their author attached; group them into creators, first seen first. */
export function tiktokCreators(items: unknown[]): SocialCreator[] {
  const videos = items.map(obj).filter((i) => handleOf(obj(i.authorMeta).name));
  return groupBy(videos, (i) => handleOf(obj(i.authorMeta).name)).map((group) => tiktokCreator(obj(group[0].authorMeta), group.map(tiktokPost)));
}

/* ---------------------------------------------------------- Instagram -- */

export function instagramPost(item: Item): SocialPost {
  const type = str(item.type, 20);
  const product = str(item.productType, 30);
  const music = obj(item.musicInfo);
  const song = str(music.song_name, 100);
  return {
    url: httpsUrl(item.url),
    postedAt: iso(item.timestamp),
    kind: product === 'clips' ? 'reel' : type === 'Video' ? 'video' : type === 'Sidecar' ? 'carousel' : 'image',
    caption: str(item.caption, 300),
    views: num(item.videoViewCount) ?? num(item.videoPlayCount),
    likes: num(item.likesCount),
    comments: num(item.commentsCount),
    shares: null,
    saves: null,
    durationSec: num(item.videoDuration),
    sponsored: item.paidPartnership === true || (Array.isArray(item.sponsors) && item.sponsors.length > 0),
    pinned: item.isPinned === true,
    sound: song ? `${song}${str(music.artist_name, 80) ? ` · ${str(music.artist_name, 80)}` : ''}` : null,
    hashtags: tags(item.hashtags),
    thumbnailUrl: httpsUrl(item.displayUrl),
  };
}

/** A profile from the Instagram scraper's "details" results, with its latest posts. */
export function instagramCreator(item: unknown): SocialCreator | null {
  const i = obj(item);
  const handle = handleOf(i.username);
  if (!handle) return null;
  return {
    platform: 'instagram',
    handle,
    name: str(i.fullName, 120),
    url: httpsUrl(i.url) ?? `https://www.instagram.com/${handle}/`,
    verified: i.verified === true,
    bio: str(i.biography, 300),
    followers: num(i.followersCount),
    following: num(i.followsCount),
    totalPosts: num(i.postsCount),
    totalLikes: null,
    totalViews: null,
    avatarUrl: httpsUrl(i.profilePicUrlHD) ?? httpsUrl(i.profilePicUrl),
    externalUrl: httpsUrl(i.externalUrl),
    // Accounts without a category report the string "None".
    category: str(i.businessCategoryName, 80)?.replace(/^None$/, '') || null,
    private: i.private === true,
    posts: (Array.isArray(i.latestPosts) ? i.latestPosts : []).map((p) => instagramPost(obj(p))),
  };
}

/** Posts from a hashtag page, grouped by who posted them. Follower counts need a profile lookup. */
export function instagramPostAuthors(items: unknown[]): SocialCreator[] {
  const posts = items.map(obj).filter((p) => handleOf(p.ownerUsername));
  return groupBy(posts, (p) => handleOf(p.ownerUsername)).map((group) => {
    const handle = handleOf(group[0].ownerUsername);
    return {
      platform: 'instagram',
      handle,
      name: str(group[0].ownerFullName, 120),
      url: `https://www.instagram.com/${handle}/`,
      verified: false,
      bio: null,
      followers: null,
      following: null,
      totalPosts: null,
      totalLikes: null,
      totalViews: null,
      avatarUrl: null,
      externalUrl: null,
      category: null,
      private: false,
      posts: group.map(instagramPost),
    };
  });
}

/* ------------------------------------------------------------ YouTube -- */

/** "00:17:17" or "4:05" → seconds. */
export function durationSeconds(v: unknown): number | null {
  if (typeof v === 'number') return num(v);
  if (typeof v !== 'string' || !/^\d+(:\d{1,2}){0,2}$/.test(v.trim())) return null;
  return v
    .trim()
    .split(':')
    .map(Number)
    .reduce((acc, n) => acc * 60 + n, 0);
}

export function youtubePost(item: Item): SocialPost {
  const url = httpsUrl(item.url);
  const type = str(item.type, 20);
  const views = num(item.viewCount);
  const likes = num(item.likes);
  return {
    url,
    postedAt: iso(item.date),
    kind: type === 'shorts' || url?.includes('/shorts/') ? 'short' : type === 'stream' ? 'live' : 'video',
    caption: str(item.title, 300),
    views,
    // Hidden like counts come back as 0; on a watched video that means unknown, not zero.
    likes: likes === 0 && (views ?? 0) > 1000 ? null : likes,
    comments: num(item.commentsCount),
    shares: null,
    saves: null,
    durationSec: durationSeconds(item.duration),
    sponsored: item.isPaidContent === true,
    pinned: false,
    sound: null,
    hashtags: tags(item.hashtags),
    thumbnailUrl: httpsUrl(item.thumbnailUrl),
  };
}

/** YouTube returns videos with channel fields on each; group them into channels. */
export function youtubeCreators(items: unknown[]): SocialCreator[] {
  const videos = items.map(obj).filter((v) => str(v.channelId) || str(v.channelUrl));
  return groupBy(videos, (v) => str(v.channelId) ?? str(v.channelUrl) ?? '').map((group) => {
    const c = group.find((v) => num(v.channelTotalVideos) != null) ?? group[0];
    const handle = handleOf(c.channelUsername) || handleOf(c.channelName);
    return {
      platform: 'youtube',
      handle,
      name: str(c.channelName, 120),
      url: httpsUrl(c.channelUrl) ?? `https://www.youtube.com/@${handle}`,
      verified: c.isChannelVerified === true,
      bio: str(c.channelDescription, 300),
      followers: num(c.numberOfSubscribers),
      following: null,
      totalPosts: num(c.channelTotalVideos),
      totalLikes: null,
      totalViews: num(c.channelTotalViews),
      avatarUrl: httpsUrl(c.channelAvatarUrl),
      externalUrl: null,
      category: null,
      private: false,
      posts: group.map(youtubePost),
    };
  });
}
