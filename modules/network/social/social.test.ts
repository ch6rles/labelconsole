import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { analyzeCreator, median } from './analysis';
import { durationSeconds, instagramCreator, instagramPostAuthors, tiktokCreators, youtubeCreators, type SocialCreator, type SocialPost } from './parse';

/** Live Apify results, trimmed; small accounts found by search are renamed and their captions replaced. */
const fixture = (name: string) => JSON.parse(readFileSync(join(__dirname, '__fixtures__', `${name}.json`), 'utf8')) as unknown[];
const NOW = new Date('2026-10-02T08:00:00Z');

describe('TikTok results', () => {
  it('turns profile videos into one creator with posts, sounds and sponsorship', () => {
    const [c, ...rest] = tiktokCreators(fixture('tiktok-profile'));
    expect(rest).toHaveLength(0);
    expect(c).toMatchObject({ platform: 'tiktok', handle: 'khaby.lame', verified: true, followers: 163_000_000, totalLikes: 2_700_000_000, totalPosts: 1357, url: 'https://www.tiktok.com/@khaby.lame' });
    expect(c.posts).toHaveLength(4);
    expect(c.posts[0]).toMatchObject({ views: 2_100_000, likes: 257_700, comments: 4344, shares: 17_300, saves: 11_719, durationSec: 34, kind: 'video', sound: 'original sound · Khabane lame (original)', hashtags: ['learnfromkhaby', 'comedy'] });
    expect(c.posts.filter((p) => p.sponsored)).toHaveLength(1);
  });

  it('groups search results by author, keeping search order', () => {
    const users = tiktokCreators(fixture('tiktok-user-search'));
    expect(users.map((u) => [u.handle, u.followers])).toEqual([
      ['editor_1', 31_500],
      ['editor_2', 509],
      ['editor_3', 55_400],
      ['editor_4', 37_400],
    ]);
    const videos = tiktokCreators(fixture('tiktok-video-search'));
    expect(videos).toHaveLength(5);
    expect(videos.at(-1)).toMatchObject({ handle: 'editor_9', followers: 262_700 });
    expect(videos.at(-1)!.posts[0].views).toBe(337_616);
  });

  it('ignores items without an author and junk values', () => {
    const [c] = tiktokCreators([{ authorMeta: {} }, { authorMeta: { name: '@Someone', fans: -5, verified: 'yes' }, playCount: 'many', webVideoUrl: 'javascript:alert(1)', createTime: 1_790_000_000 }]);
    expect(c).toMatchObject({ handle: 'someone', followers: null, verified: false });
    expect(c.posts[0]).toMatchObject({ views: null, url: null, postedAt: new Date(1_790_000_000_000).toISOString() });
  });
});

describe('Instagram results', () => {
  it('reads a profile with its latest posts', () => {
    const c = instagramCreator(fixture('instagram-details')[0])!;
    expect(c).toMatchObject({ handle: 'natgeo', name: 'National Geographic', verified: true, followers: 268_462_733, totalPosts: 32_035, category: null });
    expect(c.posts).toHaveLength(12);
    expect(c.posts[0]).toMatchObject({ kind: 'reel', views: 865_940, likes: 77_998, pinned: true, sponsored: true });
    expect(c.posts.map((p) => p.kind)).toEqual(expect.arrayContaining(['image', 'carousel', 'reel']));
  });

  it('groups hashtag posts by account; hidden likes (-1) are unknown, not negative', () => {
    const accounts = instagramPostAuthors(fixture('instagram-hashtag'));
    expect(accounts.map((a) => [a.handle, a.posts.length])).toEqual([
      ['editor_11', 2],
      ['editor_12', 5],
      ['editor_13', 1],
      ['editor_14', 1],
      ['editor_15', 1],
    ]);
    expect(accounts[0].posts.map((p) => p.likes)).toEqual([1, 0]);
    expect(accounts[1].posts.every((p) => p.likes === null)).toBe(true);
    expect(accounts[0].followers).toBeNull();
  });
});

describe('YouTube results', () => {
  it('groups videos by channel with subscribers and parses durations', () => {
    const channels = youtubeCreators(fixture('youtube-search'));
    expect(channels.map((c) => [c.handle, c.followers])).toEqual([
      ['editor_16', 28_600],
      ['editor_17', 21_600],
      ['editor_18', 7520],
      ['editor_19', 21_000],
    ]);
    // 4.2M views and 0 likes means the count is hidden.
    expect(channels[0].posts[0]).toMatchObject({ views: 4_270_570, likes: null, durationSec: 17 * 60 + 17 });
    const [mkbhd] = youtubeCreators(fixture('youtube-channel'));
    expect(mkbhd).toMatchObject({ handle: 'mkbhd', verified: true, followers: 21_300_000, totalPosts: 1855, totalViews: 5_726_706_783 });
    expect(mkbhd.posts).toHaveLength(4);
  });

  it('parses clock durations', () => {
    expect(durationSeconds('00:17:17')).toBe(1037);
    expect(durationSeconds('4:05')).toBe(245);
    expect(durationSeconds('59')).toBe(59);
    expect(durationSeconds('soon')).toBeNull();
  });
});

describe('creator analysis', () => {
  const post = (daysAgo: number, views: number | null, extra: Partial<SocialPost> = {}): SocialPost => ({
    url: `https://example.com/${daysAgo}`,
    postedAt: new Date(NOW.getTime() - daysAgo * 86_400_000).toISOString(),
    kind: 'video',
    caption: null,
    views,
    likes: views == null ? 50 : Math.round(views * 0.1),
    comments: views == null ? 2 : Math.round(views * 0.01),
    shares: views == null ? null : Math.round(views * 0.005),
    saves: null,
    durationSec: 20,
    sponsored: false,
    pinned: false,
    sound: null,
    hashtags: [],
    thumbnailUrl: null,
    ...extra,
  });
  const creator = (posts: SocialPost[], followers: number | null = 50_000): SocialCreator => ({
    platform: 'tiktok', handle: 'x', name: null, url: 'https://www.tiktok.com/@x', verified: false, bio: null, followers, following: null, totalPosts: null, totalLikes: null, totalViews: null, avatarUrl: null, externalUrl: null, category: null, private: false, posts,
  });

  it('computes the basics a buyer looks at', () => {
    const a = analyzeCreator(creator([post(3, 40_000), post(5, 60_000), post(8, 50_000), post(10, 30_000), post(13, 70_000)]), { now: NOW, priceUsd: 100 });
    expect(a).toMatchObject({ postsAnalyzed: 5, lastPostDaysAgo: 3, medianViews: 50_000, avgViews: 50_000, viewsToFollowers: 1, costPer1kViewsUsd: 2, breakoutPct: 0 });
    expect(a.postsPerWeek).toBeCloseTo(2.8, 1);
    expect(a.engagementPct).toBeCloseTo(11.5, 1);
    expect(a.signals.join(' ')).toMatch(/Reach beyond followers/);
    expect(a.signals.join(' ')).toMatch(/\$2 per 1,000 typical views/);
  });

  it('sees momentum: rising, cooling, and a fresh post that is already hot', () => {
    const rising = analyzeCreator(creator([post(3, 90_000), post(4, 80_000), post(6, 100_000), post(9, 20_000), post(11, 30_000), post(12, 25_000)]), { now: NOW });
    expect(rising.momentum).toMatchObject({ trend: 'rising', recentMedianViews: 90_000, earlierMedianViews: 25_000, change: 3.6 });
    expect(rising.signals[0]).toMatch(/Momentum is building/);

    const cooling = analyzeCreator(creator([post(3, 10_000), post(4, 12_000), post(6, 9000), post(9, 60_000), post(11, 50_000), post(12, 70_000)]), { now: NOW });
    expect(cooling.momentum.trend).toBe('cooling');
    expect(cooling.signals.join(' ')).toMatch(/Cooling off: recent posts get 83% fewer views/);

    // The 1-day-old post is left out of the trend, but flagged as trending.
    const hot = analyzeCreator(creator([post(1, 200_000), post(3, 20_000), post(5, 22_000), post(8, 18_000), post(10, 21_000)]), { now: NOW });
    expect(hot.momentum.trend).toBe('steady');
    expect(hot.signals.join(' ')).toMatch(/Trending right now: a post from the last 2 days already has 200K views/);
  });

  it('flags inactivity, weak reach, hits and paid posts, and ignores pinned posts for recency', () => {
    const a = analyzeCreator(
      creator([post(1, 5_000_000, { pinned: true }), post(40, 1000), post(42, 1200, { sponsored: true }), post(45, 900), post(47, 30_000), post(50, 1100)], 2_000_000),
      { now: NOW },
    );
    expect(a.lastPostDaysAgo).toBe(40);
    expect(a.signals[0]).toMatch(/Inactive: last post was 40 days ago/);
    expect(a.signals.join(' ')).toMatch(/Weak reach: a typical post is seen by about 0.1% of followers/);
    expect(a.signals.join(' ')).toMatch(/Hit-driven: 20% of posts/);
    expect(a.signals.join(' ')).toMatch(/1 of 6 posts are marked as paid partnerships/);
    expect(a.topPost?.views).toBe(5_000_000);
  });

  it('copes with photo accounts and with nothing at all', () => {
    const photos = analyzeCreator(creator([post(1, null), post(2, null), post(4, null)], 1000), { now: NOW });
    expect(photos).toMatchObject({ medianViews: null, medianLikes: 50, engagementPct: 5, momentum: { trend: 'unknown' } });
    const empty = analyzeCreator(creator([], null), { now: NOW });
    expect(empty).toMatchObject({ postsAnalyzed: 0, lastPostDaysAgo: null, medianViews: null, topPost: null });
    expect(empty.signals).toEqual(['No recent posts were returned, so activity and reach are unknown.']);
  });

  it('takes medians of odd and even lists', () => {
    expect(median([3, 1, 2])).toBe(2);
    expect(median([4, 1, 3, 2])).toBe(2.5);
    expect(median([])).toBeNull();
  });
});
