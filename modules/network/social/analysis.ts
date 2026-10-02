import type { SocialCreator, SocialPost } from './parse';

/**
 * What a person checks before paying a creator to post: are they still
 * posting, do their posts actually get seen, is that going up or down right
 * now, and is the audience real (views and engagement against followers).
 * The numbers are computed here so the agent reasons over facts, not guesses.
 */
export type Momentum = 'rising' | 'steady' | 'cooling' | 'unknown';

export type CreatorAnalysis = {
  postsAnalyzed: number;
  lastPostDaysAgo: number | null;
  postsPerWeek: number | null;
  medianViews: number | null;
  avgViews: number | null;
  medianLikes: number | null;
  /** Median of (likes + comments + shares) / views per post, as a percentage. */
  engagementPct: number | null;
  /** Median views divided by followers: how much of the audience a typical post reaches. */
  viewsToFollowers: number | null;
  momentum: { trend: Momentum; recentMedianViews: number | null; earlierMedianViews: number | null; change: number | null };
  /** Share of posts with at least five times the typical views. */
  breakoutPct: number | null;
  topPost: { url: string | null; views: number | null; likes: number | null; postedAt: string | null } | null;
  sponsoredPosts: number;
  /** Price per 1,000 typical views, when a price was given. */
  costPer1kViewsUsd: number | null;
  signals: string[];
};

const DAY = 86_400_000;
/** Posts younger than this are still collecting views, so they are left out of the trend. */
const SETTLE_DAYS = 2;

export function median(values: number[]): number | null {
  if (values.length === 0) return null;
  const s = [...values].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
}

const round = (n: number, digits = 0) => Math.round(n * 10 ** digits) / 10 ** digits;
const short = (n: number) => (n >= 1e6 ? `${round(n / 1e6, 1)}M` : n >= 1e4 ? `${round(n / 1e3)}K` : n >= 1e3 ? `${round(n / 1e3, 1)}K` : String(round(n)));
const ageDays = (p: SocialPost, now: number) => (p.postedAt ? (now - Date.parse(p.postedAt)) / DAY : null);

export function analyzeCreator(creator: SocialCreator, opts: { now?: Date; priceUsd?: number | null } = {}): CreatorAnalysis {
  const now = (opts.now ?? new Date()).getTime();
  // Pinned posts are old hits kept on top; they say nothing about today.
  const posts = creator.posts.filter((p) => !p.pinned && p.postedAt).sort((a, b) => Date.parse(b.postedAt!) - Date.parse(a.postedAt!));
  const all = creator.posts;
  const signals: string[] = [];

  const lastPostDaysAgo = posts.length ? round(ageDays(posts[0], now)!, 1) : null;
  let postsPerWeek: number | null = null;
  if (posts.length >= 3) {
    const spanDays = (Date.parse(posts[0].postedAt!) - Date.parse(posts[posts.length - 1].postedAt!)) / DAY;
    if (spanDays >= 1) postsPerWeek = round(((posts.length - 1) / spanDays) * 7, 1);
  }

  // Photo posts have no view counts; they count for activity and likes only.
  const viewed = posts.filter((p) => p.views != null);
  const views = viewed.map((p) => p.views!);
  const medianViews = median(views);
  const avgViews = views.length ? round(views.reduce((a, b) => a + b, 0) / views.length) : null;
  const medianLikes = median(posts.map((p) => p.likes).filter((n): n is number => n != null));

  const rates = viewed.filter((p) => p.views! > 0 && p.likes != null).map((p) => ((p.likes ?? 0) + (p.comments ?? 0) + (p.shares ?? 0)) / p.views!);
  let engagementPct = rates.length ? round(median(rates)! * 100, 1) : null;
  // Photo-only accounts (no view counts): engagement against followers instead.
  if (engagementPct == null && creator.followers && medianLikes != null) engagementPct = round((medianLikes / creator.followers) * 100, 1);

  const viewsToFollowers = medianViews != null && creator.followers ? round(medianViews / creator.followers, 3) : null;

  const settled = viewed.filter((p) => ageDays(p, now)! >= SETTLE_DAYS);
  let momentum: CreatorAnalysis['momentum'] = { trend: 'unknown', recentMedianViews: null, earlierMedianViews: null, change: null };
  if (settled.length >= 4) {
    const half = Math.floor(settled.length / 2);
    const recent = median(settled.slice(0, half).map((p) => p.views!))!;
    const earlier = median(settled.slice(half).map((p) => p.views!))!;
    const change = earlier > 0 ? round(recent / earlier, 2) : null;
    momentum = { trend: change == null ? 'unknown' : change >= 1.3 ? 'rising' : change <= 0.7 ? 'cooling' : 'steady', recentMedianViews: recent, earlierMedianViews: earlier, change };
  }

  const breakoutPct = medianViews && views.length >= 4 ? round((views.filter((v) => v >= medianViews * 5).length / views.length) * 100) : null;
  const top = [...all].filter((p) => p.views != null || p.likes != null).sort((a, b) => (b.views ?? b.likes ?? 0) - (a.views ?? a.likes ?? 0))[0];
  const sponsoredPosts = all.filter((p) => p.sponsored).length;
  const costPer1kViewsUsd = opts.priceUsd && medianViews ? round(opts.priceUsd / (medianViews / 1000), 2) : null;

  /* Plain-language observations, most decisive first. */
  if (creator.private) signals.push('The account is private.');
  if (posts.length === 0) signals.push('No recent posts were returned, so activity and reach are unknown.');
  if (lastPostDaysAgo != null && lastPostDaysAgo > 30) signals.push(`Inactive: last post was ${Math.round(lastPostDaysAgo)} days ago.`);
  else if (lastPostDaysAgo != null && lastPostDaysAgo > 14) signals.push(`Slowing down: last post was ${Math.round(lastPostDaysAgo)} days ago.`);
  if (momentum.trend === 'rising') signals.push(`Momentum is building: recent posts get ${momentum.change}× the views of earlier ones (${short(momentum.recentMedianViews!)} vs ${short(momentum.earlierMedianViews!)}).`);
  if (momentum.trend === 'cooling') signals.push(`Cooling off: recent posts get ${Math.round((1 - momentum.change!) * 100)}% fewer views than earlier ones (${short(momentum.recentMedianViews!)} vs ${short(momentum.earlierMedianViews!)}).`);
  const fresh = viewed.filter((p) => ageDays(p, now)! < SETTLE_DAYS);
  const settledMedian = median(settled.map((p) => p.views!));
  const hot = fresh.find((p) => settledMedian && p.views! > settledMedian * 1.5);
  if (hot) signals.push(`Trending right now: a post from the last ${SETTLE_DAYS} days already has ${short(hot.views!)} views, above their usual ${short(settledMedian!)}.`);
  if (viewsToFollowers != null && viewsToFollowers >= 1) signals.push(`Reach beyond followers: a typical post gets ${viewsToFollowers}× their follower count in views, so the platform is pushing their content.`);
  else if (viewsToFollowers != null && viewsToFollowers < 0.05 && (creator.followers ?? 0) >= 10_000) signals.push(`Weak reach: a typical post is seen by about ${round(viewsToFollowers * 100, 1)}% of followers, so the follower count overstates what a promo would get.`);
  if (engagementPct != null && engagementPct < 1 && views.length) signals.push(`Low engagement (${engagementPct}%): views are not turning into likes or comments.`);
  else if (engagementPct != null && engagementPct >= 8) signals.push(`Strong engagement (${engagementPct}%).`);
  if (breakoutPct != null && breakoutPct > 0) signals.push(`Hit-driven: ${breakoutPct}% of posts got 5× or more their typical views, so a single promo post can land far above or below the median.`);
  if (sponsoredPosts > 0) signals.push(`${sponsoredPosts} of ${all.length} posts are marked as paid partnerships, so they do take sponsored posts.`);
  if (costPer1kViewsUsd != null) signals.push(`At $${opts.priceUsd} a post, that is about $${costPer1kViewsUsd} per 1,000 typical views.`);

  return {
    postsAnalyzed: all.length,
    lastPostDaysAgo,
    postsPerWeek,
    medianViews,
    avgViews,
    medianLikes,
    engagementPct,
    viewsToFollowers,
    momentum,
    breakoutPct,
    topPost: top ? { url: top.url, views: top.views, likes: top.likes, postedAt: top.postedAt } : null,
    sponsoredPosts,
    costPer1kViewsUsd,
    signals,
  };
}
