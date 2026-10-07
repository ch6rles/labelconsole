import '../types';
import { and, asc, desc, eq, gte, ilike, inArray, isNotNull, isNull, lte, ne, or, sql } from 'drizzle-orm';
import { z } from 'zod';
import { patchOf } from '@labelconsole/core/zod';
import type { ServiceContext } from '@labelconsole/core/context';
import { credentials, organizations } from '@labelconsole/core/db/schema';
import { env } from '@labelconsole/core/env';
import { apifyConfigured } from '@labelconsole/core/apify';
import { normName, spotifyIdFrom, spotScraperConfigured } from '@labelconsole/core/spotscraper';
import { NotFoundError, ValidationError } from '@labelconsole/core/errors';
import { enabledModuleIds, enrich } from '@labelconsole/core/modules';
import { assertWithinPlan, lockPlanLimit, planOf } from '@labelconsole/core/plans';
import { enqueueAfterCommit } from '@labelconsole/core/queue';
import { platformIdentities, releaseTracks, releases, tracks } from '@labelconsole/catalogue/schema';
import { artistsOnTrack, creditedTracks, setIdentityStatus, upsertIdentity } from '@labelconsole/catalogue/service';
import { artists } from '@labelconsole/people/schema';
import { updateArtist } from '@labelconsole/people/service';
import { alertRules, alerts, ALERT_KINDS, artistSpotifyStats, streamDaily, streamTracks, type AlertKind, type DiscoveredOn, type StreamSource, type TopCity } from '../schema';
import { streamSnapshots } from '../schema/snapshots';
import { parseVideoId } from '../sources/youtube';
import type { Snapshot, TrackArtistRefs } from '../sources/types';
import { DEFAULT_RULES, evaluateRules, nextPollAt, type DayPoint } from './alerts';
import { addDays, MAX_SPREAD_DAYS, settle } from './settle';

export { DEFAULT_RULES, evaluateRules, nextPollAt } from './alerts';

/** Sources that report running totals; their daily deltas are plays. Statements are period totals. */
export const POLLED_SOURCES: StreamSource[] = ['youtube-data-api', 'youtube-scraper', 'spotscraper', 'licensed-provider'];
const polled = sql.raw(`('youtube-data-api','youtube-scraper','spotscraper','licensed-provider')`);

const today = () => new Date().toISOString().slice(0, 10);
const daysAgo = (n: number) => new Date(Date.now() - n * 86400_000).toISOString().slice(0, 10);

/* ---------------------------------------------------------- registry --- */

/**
 * Register a catalogue track with the tracker. Tracks that already have a
 * confirmed YouTube video or Spotify ID start polling right away; the rest go
 * to the resolver, which searches Spotify by ISRC and YouTube once.
 */
export async function registerTrack(ctx: ServiceContext, trackId: string) {
  const [track] = await ctx.tx.select({ id: tracks.id, isrc: tracks.isrc }).from(tracks).where(eq(tracks.id, trackId));
  if (!track) return null;
  const [existing] = await ctx.tx.select({ id: streamTracks.id }).from(streamTracks).where(eq(streamTracks.trackId, trackId));
  if (!existing) {
    // Over the plan's tracking limit a new track waits unregistered; the scheduler's backfill adds it once there's room.
    await lockPlanLimit(ctx, 'trackedTracks');
    if ((await activeTrackCount(ctx)) >= (await planOf(ctx)).limits.trackedTracks) return null;
  }
  const [row] = await ctx.tx.insert(streamTracks).values({ trackId, isrc: track.isrc }).onConflictDoUpdate({ target: [streamTracks.orgId, streamTracks.trackId], set: { isrc: track.isrc } }).returning();
  if (row.status === 'paused') return row;
  const known = await pollableTrackIds(ctx, [trackId]);
  if (known.size) {
    if (row.status !== 'tracking') await ctx.tx.update(streamTracks).set({ status: 'tracking', nextPollAt: new Date() }).where(eq(streamTracks.id, row.id));
  } else if (!row.lastResolvedAt) {
    enqueueAfterCommit(ctx, 'streams.resolve-track', { streamTrackId: row.id }, { jobId: `resolve-${row.id}`, attempts: 3, backoff: { type: 'exponential', delay: 60_000 } });
  }
  return row;
}

/** Tracks that count against the plan: everything registered and not paused. */
export async function activeTrackCount(ctx: ServiceContext) {
  const [r] = await ctx.tx.select({ n: sql<number>`count(*)::int` }).from(streamTracks).where(ne(streamTracks.status, 'paused'));
  return r?.n ?? 0;
}

export async function confirmedVideos(ctx: ServiceContext, trackIds: string[]) {
  if (trackIds.length === 0) return [];
  return ctx.tx
    .select({ id: platformIdentities.id, trackId: platformIdentities.entityId, externalId: platformIdentities.externalId, variant: platformIdentities.variant })
    .from(platformIdentities)
    .where(and(eq(platformIdentities.entityType, 'track'), inArray(platformIdentities.entityId, trackIds), eq(platformIdentities.platform, 'youtube'), eq(platformIdentities.status, 'confirmed')));
}

/** The Spotify ID each track is polled through (one per track, see sources/spotify.ts). */
export async function spotifyPrimaries(ctx: ServiceContext, trackIds: string[]) {
  if (trackIds.length === 0) return [];
  return ctx.tx
    .select({ id: platformIdentities.id, trackId: platformIdentities.entityId, externalId: platformIdentities.externalId })
    .from(platformIdentities)
    .where(and(eq(platformIdentities.entityType, 'track'), inArray(platformIdentities.entityId, trackIds), eq(platformIdentities.platform, 'spotify'), eq(platformIdentities.status, 'confirmed'), eq(platformIdentities.variant, 'primary')));
}

/** Tracks with something to poll: a confirmed YouTube video or a Spotify ID. */
export async function pollableTrackIds(ctx: ServiceContext, trackIds: string[]) {
  const [videos, spotify] = await Promise.all([confirmedVideos(ctx, trackIds), spotifyPrimaries(ctx, trackIds)]);
  return new Set([...videos.map((v) => v.trackId), ...spotify.map((s) => s.trackId)]);
}

/**
 * Make one confirmed Spotify identity per track the polled one, for tracks
 * that have Spotify IDs (from a metadata lookup or import) but none chosen.
 * No request is made. Returns the track IDs that now have a primary.
 */
export async function promoteSpotifyPrimaries(ctx: ServiceContext, trackIds: string[]) {
  if (trackIds.length === 0) return new Set<string>();
  const have = new Set((await spotifyPrimaries(ctx, trackIds)).map((p) => p.trackId));
  const rows = await ctx.tx
    .select({ id: platformIdentities.id, trackId: platformIdentities.entityId })
    .from(platformIdentities)
    .where(and(eq(platformIdentities.entityType, 'track'), inArray(platformIdentities.entityId, trackIds.filter((t) => !have.has(t))), eq(platformIdentities.platform, 'spotify'), eq(platformIdentities.status, 'confirmed')))
    .orderBy(desc(platformIdentities.confidence), asc(platformIdentities.createdAt));
  for (const r of rows) {
    if (have.has(r.trackId)) continue;
    await ctx.tx.update(platformIdentities).set({ variant: 'primary' }).where(eq(platformIdentities.id, r.id));
    have.add(r.trackId);
  }
  return have;
}

export const TrackListQuery = z.object({ q: z.string().trim().max(100).optional(), status: z.enum(['pending_match', 'tracking', 'paused']).optional() });

export async function listTracked(ctx: ServiceContext, q: z.infer<typeof TrackListQuery> = {}) {
  ctx.assert('streams:read');
  const conds = [];
  if (q.status) conds.push(eq(streamTracks.status, q.status));
  if (q.q) conds.push(or(ilike(tracks.title, `%${q.q}%`), ilike(tracks.isrc, `%${q.q.replace(/-/g, '')}%`)));
  const rows = await ctx.tx
    .select({ st: streamTracks, title: tracks.title, isrc: tracks.isrc })
    .from(streamTracks)
    .innerJoin(tracks, eq(tracks.id, streamTracks.trackId))
    .where(conds.length ? and(...conds) : undefined)
    .orderBy(asc(tracks.title))
    .limit(1000);
  const ids = rows.map((r) => r.st.trackId);
  if (ids.length === 0) return [];
  const [names, videos, spotify, daily, byPlatform] = await Promise.all([
    artistNames(ctx, ids),
    confirmedVideos(ctx, ids),
    spotifyPrimaries(ctx, ids),
    ctx.tx
      .select({ trackId: streamDaily.trackId, day: streamDaily.day, delta: sql<number>`sum(${streamDaily.delta})::bigint`, total: sql<number>`sum(${streamDaily.total})::bigint` })
      .from(streamDaily)
      .where(and(inArray(streamDaily.trackId, ids), gte(streamDaily.day, daysAgo(28)), sql`${streamDaily.source} in ${polled}`))
      .groupBy(streamDaily.trackId, streamDaily.day)
      .orderBy(asc(streamDaily.day)),
    ctx.tx
      .select({ trackId: streamDaily.trackId, platform: streamDaily.platform, plays: sql<number>`sum(${streamDaily.delta})::bigint` })
      .from(streamDaily)
      .where(and(inArray(streamDaily.trackId, ids), gte(streamDaily.day, daysAgo(27)), sql`${streamDaily.source} in ${polled}`))
      .groupBy(streamDaily.trackId, streamDaily.platform),
  ]);
  const plays28dOn = (trackId: string, platform: string) => {
    const r = byPlatform.find((p) => p.trackId === trackId && p.platform === platform);
    return r ? Number(r.plays) : null;
  };
  return rows.map((r) => {
    const days = daily.filter((d) => d.trackId === r.st.trackId);
    return {
      ...r.st,
      title: r.title,
      isrc: r.isrc,
      artists: names.get(r.st.trackId) ?? [],
      videos: videos.filter((v) => v.trackId === r.st.trackId).length,
      artTrack: videos.some((v) => v.trackId === r.st.trackId && v.variant === 'topic'),
      spotify: spotify.some((p) => p.trackId === r.st.trackId),
      spotify28d: plays28dOn(r.st.trackId, 'spotify'),
      youtubeMusic28d: plays28dOn(r.st.trackId, 'youtube_music'),
      plays28d: days.reduce((a, d) => a + Number(d.delta), 0),
      total: days.length ? Number(days.at(-1)!.total) : null,
      spark: days.map((d) => Number(d.delta)),
    };
  });
}

/** Every artist on each track, lead artists first, for lists and alerts. */
async function artistNames(ctx: ServiceContext, trackIds: string[]) {
  const on = await artistsOnTrack(ctx, trackIds);
  return new Map([...on].map(([trackId, list]) => [trackId, list.map((a) => a.name)]));
}

export async function getTracked(ctx: ServiceContext, trackId: string) {
  ctx.assert('streams:read');
  const [row] = await ctx.tx.select({ st: streamTracks, track: tracks }).from(tracks).leftJoin(streamTracks, eq(streamTracks.trackId, tracks.id)).where(eq(tracks.id, trackId));
  if (!row) throw new NotFoundError('Track');
  const [names, identities, openAlerts, spotScraper] = await Promise.all([
    artistNames(ctx, [trackId]),
    ctx.tx.select().from(platformIdentities).where(and(eq(platformIdentities.entityType, 'track'), eq(platformIdentities.entityId, trackId), inArray(platformIdentities.platform, ['youtube', 'spotify']))).orderBy(desc(platformIdentities.confidence)),
    ctx.tx.select().from(alerts).where(eq(alerts.trackId, trackId)).orderBy(desc(alerts.createdAt)).limit(20),
    spotScraperConfigured(ctx),
  ]);
  return {
    tracked: row.st,
    track: row.track,
    artists: names.get(trackId) ?? [],
    youtube: identities.filter((i) => i.platform === 'youtube'),
    // The polled ID first.
    spotify: identities.filter((i) => i.platform === 'spotify').sort((a, b) => Number(b.variant === 'primary') - Number(a.variant === 'primary')),
    spotScraper,
    alerts: openAlerts,
  };
}

export async function setTrackStatus(ctx: ServiceContext, trackId: string, status: 'tracking' | 'paused') {
  ctx.assert('streams:manage');
  if (status === 'tracking') {
    const [current] = await ctx.tx.select({ status: streamTracks.status }).from(streamTracks).where(eq(streamTracks.trackId, trackId));
    if (current?.status === 'paused') {
      await lockPlanLimit(ctx, 'trackedTracks');
      await assertWithinPlan(ctx, 'trackedTracks', await activeTrackCount(ctx));
    }
  }
  const [row] = await ctx.tx.update(streamTracks).set({ status: status === 'tracking' ? ((await pollableTrackIds(ctx, [trackId])).size ? 'tracking' : 'pending_match') : 'paused', nextPollAt: status === 'tracking' ? new Date() : null }).where(eq(streamTracks.trackId, trackId)).returning();
  if (!row) throw new NotFoundError('Tracked track');
  await ctx.audit({ action: status === 'paused' ? 'streams.tracking_paused' : 'streams.tracking_resumed', module: 'streams', targetType: 'track', targetId: trackId });
  return row;
}

/** Make tracks due now and queue a poll (staff "refresh now"). */
export async function requestPoll(ctx: ServiceContext, trackId?: string) {
  ctx.assert('streams:manage');
  await ctx.tx.update(streamTracks).set({ nextPollAt: new Date() }).where(and(eq(streamTracks.status, 'tracking'), trackId ? eq(streamTracks.trackId, trackId) : undefined));
  enqueueAfterCommit(ctx, 'streams.poll-org', { force: true }, { jobId: `poll-${ctx.orgId}-manual-${Math.floor(Date.now() / 60_000)}` });
  return { queued: true };
}

/** Search YouTube (100 quota units) and Spotify by ISRC again for a track. */
export async function requestResolve(ctx: ServiceContext, trackId: string) {
  ctx.assert('streams:manage');
  const row = (await ctx.tx.select().from(streamTracks).where(eq(streamTracks.trackId, trackId)))[0] ?? (await registerTrack(ctx, trackId));
  if (!row) throw new NotFoundError('Track');
  await ctx.tx.update(streamTracks).set({ lastResolvedAt: null, spotifyCheckedAt: null, lastError: null }).where(eq(streamTracks.id, row.id));
  enqueueAfterCommit(ctx, 'streams.resolve-track', { streamTrackId: row.id }, { jobId: `resolve-${row.id}-${Date.now()}`, attempts: 2 });
  return { queued: true };
}

/* ---------------------------------------------------------- matching --- */

export async function matchingQueue(ctx: ServiceContext) {
  ctx.assert('streams:manage');
  const pending = await ctx.tx
    .select({ identity: platformIdentities, title: tracks.title, isrc: tracks.isrc, durationMs: tracks.durationMs })
    .from(platformIdentities)
    .innerJoin(tracks, eq(tracks.id, platformIdentities.entityId))
    .where(and(eq(platformIdentities.entityType, 'track'), eq(platformIdentities.platform, 'youtube'), eq(platformIdentities.status, 'pending_review')))
    .orderBy(desc(platformIdentities.confidence))
    .limit(300);
  const unmatched = await ctx.tx
    .select({ st: streamTracks, title: tracks.title, isrc: tracks.isrc })
    .from(streamTracks)
    .innerJoin(tracks, eq(tracks.id, streamTracks.trackId))
    .where(eq(streamTracks.status, 'pending_match'))
    .orderBy(asc(tracks.title))
    .limit(300);
  const names = await artistNames(ctx, [...new Set([...pending.map((p) => p.identity.entityId), ...unmatched.map((u) => u.st.trackId)])]);
  return {
    pending: pending.map((p) => ({ ...p, artists: names.get(p.identity.entityId) ?? [] })),
    unmatched: unmatched.filter((u) => !pending.some((p) => p.identity.entityId === u.st.trackId)).map((u) => ({ ...u, artists: names.get(u.st.trackId) ?? [] })),
  };
}

export async function reviewMatch(ctx: ServiceContext, identityId: string, status: 'confirmed' | 'rejected') {
  ctx.assert('streams:manage');
  const [identity] = await ctx.tx.select().from(platformIdentities).where(and(eq(platformIdentities.id, identityId), eq(platformIdentities.platform, 'youtube')));
  if (!identity) throw new NotFoundError('YouTube match');
  const row = await setIdentityStatus(ctx, identityId, status);
  if (status === 'confirmed') await ctx.tx.update(streamTracks).set({ status: 'tracking', nextPollAt: new Date() }).where(and(eq(streamTracks.trackId, row.entityId), or(eq(streamTracks.status, 'pending_match'), eq(streamTracks.status, 'tracking'))));
  if (status === 'confirmed') enqueueAfterCommit(ctx, 'streams.poll-org', { force: true }, { jobId: `poll-${ctx.orgId}-review-${Math.floor(Date.now() / 60_000)}` });
  return row;
}

export const AddVideoInput = z.object({ video: z.string().trim().min(5).max(300), kind: z.enum(['art_track', 'video']).optional() });

/**
 * Staff paste a YouTube link for a track; it is confirmed straight away. The
 * art track (its Topic upload, what YouTube Music plays) counts as YouTube
 * Music; a music.youtube.com link is taken as the art track unless told otherwise.
 */
export async function addVideo(ctx: ServiceContext, trackId: string, input: z.infer<typeof AddVideoInput>) {
  ctx.assert('streams:manage');
  const videoId = parseVideoId(input.video);
  if (!videoId) throw new ValidationError('That is not a YouTube video link', { fieldErrors: { video: ['Paste a youtube.com or youtu.be link'] } });
  const tracked = (await ctx.tx.select().from(streamTracks).where(eq(streamTracks.trackId, trackId)))[0] ?? (await registerTrack(ctx, trackId));
  if (!tracked) throw new NotFoundError('Track');
  const artTrack = input.kind ? input.kind === 'art_track' : /(^|\/\/)music\.youtube\.com\//i.test(input.video);
  const identity = await upsertIdentity(ctx, { entityType: 'track', entityId: trackId, platform: 'youtube', externalId: videoId, url: `https://www.youtube.com/watch?v=${videoId}`, source: 'manual', confidence: 1, status: 'confirmed', variant: artTrack ? 'topic' : 'official' });
  if (identity.status !== 'confirmed') await setIdentityStatus(ctx, identity.id, 'confirmed');
  await ctx.tx.update(streamTracks).set({ status: 'tracking', nextPollAt: new Date() }).where(eq(streamTracks.trackId, trackId));
  enqueueAfterCommit(ctx, 'streams.poll-org', { force: true }, { jobId: `poll-${ctx.orgId}-video-${Math.floor(Date.now() / 60_000)}` });
  return identity;
}

export const SpotifyTrackInput = z.object({ spotify: z.string().trim().min(10).max(300) });

/**
 * Staff paste the Spotify link of a track; it becomes the ID play counts are
 * polled through, replacing any earlier choice. The series continues without
 * a jump: the rollup reads one Spotify ID at a time.
 */
export async function setSpotifyTrack(ctx: ServiceContext, trackId: string, input: z.infer<typeof SpotifyTrackInput>) {
  ctx.assert('streams:manage');
  const id = spotifyIdFrom(input.spotify, 'track');
  if (!id) throw new ValidationError('That is not a Spotify track link', { fieldErrors: { spotify: ['Paste an open.spotify.com/track/… link'] } });
  const tracked = (await ctx.tx.select().from(streamTracks).where(eq(streamTracks.trackId, trackId)))[0] ?? (await registerTrack(ctx, trackId));
  if (!tracked) throw new NotFoundError('Track');
  await ctx.tx
    .update(platformIdentities)
    .set({ variant: null })
    .where(and(eq(platformIdentities.entityType, 'track'), eq(platformIdentities.entityId, trackId), eq(platformIdentities.platform, 'spotify'), eq(platformIdentities.variant, 'primary')));
  const identity = await upsertIdentity(ctx, { entityType: 'track', entityId: trackId, platform: 'spotify', externalId: id, url: `https://open.spotify.com/track/${id}`, source: 'manual', confidence: 1, status: 'confirmed', variant: 'primary' });
  if (identity.status !== 'confirmed') await setIdentityStatus(ctx, identity.id, 'confirmed');
  await ctx.tx.update(streamTracks).set({ status: tracked.status === 'paused' ? 'paused' : 'tracking', nextPollAt: new Date() }).where(eq(streamTracks.trackId, trackId));
  await ctx.audit({ action: 'streams.spotify_set', module: 'streams', targetType: 'track', targetId: trackId, targetLabel: id });
  enqueueAfterCommit(ctx, 'streams.poll-org', { force: true }, { jobId: `poll-${ctx.orgId}-spotify-${Math.floor(Date.now() / 60_000)}` });
  return identity;
}

/* --------------------------------------------------------- recording --- */

/**
 * Append snapshots and refresh the daily rollup of each affected series.
 * YouTube sums the latest reading of every video a track has, and counts a
 * video's growth only from its second reading, so adding a new video never
 * looks like a spike. Other polled sources read one ID per track: the latest
 * reading, with growth only while the ID stays the same.
 */
export async function recordSnapshots(ctx: ServiceContext, snaps: Snapshot[]) {
  if (snaps.length === 0) return [];
  for (let i = 0; i < snaps.length; i += 500) {
    await ctx.tx.insert(streamSnapshots).values(snaps.slice(i, i + 500).map((s) => ({ trackId: s.trackId, platform: s.platform, source: s.source, externalId: s.externalId, capturedAt: s.capturedAt, count: s.count })));
  }
  const series = new Map<string, { trackId: string; platform: string; source: StreamSource; day: string }>();
  for (const s of snaps) series.set(`${s.trackId}|${s.platform}|${s.source}|${s.capturedAt.toISOString().slice(0, 10)}`, { trackId: s.trackId, platform: s.platform, source: s.source, day: s.capturedAt.toISOString().slice(0, 10) });
  const out = [];
  for (const s of series.values()) out.push({ ...s, ...(await rollupDay(ctx, s.trackId, s.platform, s.source, s.day)) });
  return out;
}

async function rollupDay(ctx: ServiceContext, trackId: string, platform: string, source: StreamSource, day: string) {
  const start = `${day}T00:00:00Z`;
  const end = new Date(Date.parse(start) + 86400_000).toISOString();
  // YouTube sums every confirmed video of a track (art track and official video); other sources poll one ID.
  if (source !== 'youtube-data-api' && source !== 'youtube-scraper') return rollupSingle(ctx, trackId, platform, source, day, start, end);
  const [row] = (await ctx.tx.execute(sql`
    with cur as (
      select distinct on (coalesce(external_id, '')) coalesce(external_id, '') as ext, count
      from stream_snapshots
      where track_id = ${trackId} and platform = ${platform} and source = ${source}
        and captured_at >= ${start}::timestamptz - interval '30 days' and captured_at < ${end}::timestamptz
      order by coalesce(external_id, ''), captured_at desc
    ), prev as (
      select distinct on (coalesce(external_id, '')) coalesce(external_id, '') as ext, count
      from stream_snapshots
      where track_id = ${trackId} and platform = ${platform} and source = ${source}
        and captured_at >= ${start}::timestamptz - interval '30 days' and captured_at < ${start}::timestamptz
      order by coalesce(external_id, ''), captured_at desc
    )
    select coalesce(sum(cur.count), 0)::bigint as total,
           coalesce(sum(case when prev.count is null then 0 else greatest(cur.count - prev.count, 0) end), 0)::bigint as delta
    from cur left join prev using (ext)
  `)) as unknown as Array<{ total: string; delta: string }>;
  return saveReading(ctx, trackId, platform, source, day, Number(row?.total ?? 0), Number(row?.delta ?? 0));
}

/** Store a day's reading (its change as read), then settle the series so late refreshes don't read as 0 plays. */
async function saveReading(ctx: ServiceContext, trackId: string, platform: string, source: StreamSource, day: string, total: number, rawDelta: number) {
  await ctx.tx
    .insert(streamDaily)
    .values({ trackId, platform, source, day, total, delta: rawDelta, rawDelta })
    .onConflictDoUpdate({ target: [streamDaily.orgId, streamDaily.trackId, streamDaily.platform, streamDaily.source, streamDaily.day], set: { total, rawDelta } });
  const settled = await settleSeries(ctx, trackId, platform, source, day);
  const today = settled.find((d) => d.day === day);
  return { total, delta: today?.delta ?? rawDelta, pending: today?.pending ?? false, estimated: today?.estimated ?? false };
}

/**
 * Re-settle a series' recent days from its readings (see ./settle): pending
 * days for counts the platform hasn't refreshed, catch-ups spread over the
 * days they cover, missed days filled in. Only days a spread could reach are
 * rewritten; the weeks before them are read to know where the series stood.
 */
async function settleSeries(ctx: ServiceContext, trackId: string, platform: string, source: StreamSource, day: string) {
  const series = and(eq(streamDaily.trackId, trackId), eq(streamDaily.platform, platform), eq(streamDaily.source, source));
  const rows = await ctx.tx
    .select({ day: sql<string>`${streamDaily.day}::text`, total: streamDaily.total, rawDelta: streamDaily.rawDelta, delta: streamDaily.delta, estimated: streamDaily.estimated, pending: streamDaily.pending })
    .from(streamDaily)
    .where(and(series, gte(streamDaily.day, addDays(day, -(MAX_SPREAD_DAYS + 21)))))
    .orderBy(streamDaily.day);
  const from = addDays(day, -MAX_SPREAD_DAYS);
  const settled = settle(rows).filter((d) => d.day >= from);
  const keep = new Set(settled.map((d) => d.day));
  const before = new Map(rows.map((r) => [r.day, r]));
  // Days filled in earlier that no longer need filling (a late reading arrived for them) go.
  const stale = rows.filter((r) => r.rawDelta === null && r.day >= from && !keep.has(r.day)).map((r) => r.day);
  if (stale.length) await ctx.tx.delete(streamDaily).where(and(series, inArray(streamDaily.day, stale)));
  for (const d of settled) {
    const b = before.get(d.day);
    if (b && b.delta === d.delta && b.estimated === d.estimated && b.pending === d.pending && b.total === d.total) continue;
    await ctx.tx
      .insert(streamDaily)
      .values({ trackId, platform, source, day: d.day, total: d.total, delta: d.delta, rawDelta: d.filled ? null : (b?.rawDelta ?? d.delta), estimated: d.estimated, pending: d.pending })
      .onConflictDoUpdate({ target: [streamDaily.orgId, streamDaily.trackId, streamDaily.platform, streamDaily.source, streamDaily.day], set: { total: d.total, delta: d.delta, estimated: d.estimated, pending: d.pending } });
  }
  // An open spike or drop raised on a figure the series no longer shows (a late refresh read as 0 plays,
  // or two days of plays read as one) is withdrawn. Alerts already seen are left alone.
  const byDay = new Map(settled.map((d) => [d.day, d]));
  const open = await ctx.tx
    .select({ id: alerts.id, day: sql<string>`${alerts.day}::text`, value: alerts.value })
    .from(alerts)
    .where(and(eq(alerts.trackId, trackId), eq(alerts.platform, platform), inArray(alerts.kind, ['spike', 'drop']), gte(alerts.day, from), isNull(alerts.acknowledgedAt)));
  const withdrawn = open.filter((a) => {
    const d = byDay.get(a.day);
    return d && (d.pending || (d.estimated && a.value !== d.delta));
  });
  if (withdrawn.length) await ctx.tx.delete(alerts).where(inArray(alerts.id, withdrawn.map((a) => a.id)));
  return settled;
}

/** One running total per track: the newest reading, growth counted only against a reading of the same ID. */
async function rollupSingle(ctx: ServiceContext, trackId: string, platform: string, source: StreamSource, day: string, start: string, end: string) {
  const [row] = (await ctx.tx.execute(sql`
    with cur as (
      select coalesce(external_id, '') as ext, count from stream_snapshots
      where track_id = ${trackId} and platform = ${platform} and source = ${source}
        and captured_at >= ${start}::timestamptz - interval '30 days' and captured_at < ${end}::timestamptz
      order by captured_at desc limit 1
    ), prev as (
      select coalesce(external_id, '') as ext, count from stream_snapshots
      where track_id = ${trackId} and platform = ${platform} and source = ${source}
        and captured_at >= ${start}::timestamptz - interval '30 days' and captured_at < ${start}::timestamptz
      order by captured_at desc limit 1
    )
    select coalesce(cur.count, 0)::bigint as total,
           coalesce(case when prev.ext = cur.ext then greatest(cur.count - prev.count, 0) else 0 end, 0)::bigint as delta
    from cur left join prev on true
  `)) as unknown as Array<{ total: string; delta: string }>;
  return saveReading(ctx, trackId, platform, source, day, Number(row?.total ?? 0), Number(row?.delta ?? 0));
}

/**
 * Statement counts for the given tracks, recomputed from every current
 * statement so a corrected or re-imported statement replaces, never adds.
 */
export async function rollupStatementCounts(ctx: ServiceContext, totals: Array<{ trackId: string; platform: string; periodEnd: string; units: number }>) {
  for (const t of totals) {
    await ctx.tx
      .insert(streamDaily)
      .values({ trackId: t.trackId, platform: t.platform, source: 'statement-import', day: t.periodEnd, total: t.units, delta: t.units, rawDelta: t.units })
      .onConflictDoUpdate({ target: [streamDaily.orgId, streamDaily.trackId, streamDaily.platform, streamDaily.source, streamDaily.day], set: { total: t.units, delta: t.units, rawDelta: t.units } });
    // The append-only audit trail: one snapshot per distinct reading.
    await ctx.tx.execute(sql`
      insert into stream_snapshots (track_id, platform, source, external_id, captured_at, count)
      select ${t.trackId}, ${t.platform}, 'statement-import', null, ${`${t.periodEnd}T23:59:59Z`}::timestamptz, ${t.units}
      where not exists (
        select 1 from stream_snapshots where track_id = ${t.trackId} and platform = ${t.platform} and source = 'statement-import'
          and captured_at = ${`${t.periodEnd}T23:59:59Z`}::timestamptz and count = ${t.units}
      )`);
  }
}

/* ----------------------------------------------------------- tiering --- */

/** Active tracks poll every 6 hours: recent or upcoming releases, plus anything another module marks active (live campaigns). */
export async function activeTrackIds(ctx: ServiceContext, trackIds: string[]) {
  if (trackIds.length === 0) return new Set<string>();
  const recent = await ctx.tx
    .selectDistinct({ trackId: releaseTracks.trackId })
    .from(releaseTracks)
    .innerJoin(releases, eq(releases.id, releaseTracks.releaseId))
    .where(and(inArray(releaseTracks.trackId, trackIds), gte(releases.releaseDate, daysAgo(90))));
  const active = new Set(recent.map((r) => r.trackId));
  const [org] = await ctx.tx.select({ id: organizations.id, plan: organizations.plan }).from(organizations).where(eq(organizations.id, ctx.orgId));
  if (org) {
    const extra = await enrich(ctx, await enabledModuleIds(ctx.tx, org), 'stream-tier', trackIds);
    for (const [id, v] of Object.entries(extra)) if (v.active) active.add(id);
  }
  return active;
}

/* ----------------------------------------------------------- queries --- */

export const HistoryQuery = z.object({
  platform: z.string().max(40).optional(),
  from: z.iso.date().optional(),
  to: z.iso.date().optional(),
  granularity: z.enum(['day', 'week', 'month']).default('day'),
});

type SeriesRow = { platform: string; source: string; day: string; total: number; delta: number; pending: boolean; estimated: boolean };
/** A history point. `pending`: the platform hasn't refreshed since the last reading, so the plays aren't known yet (never 0). `estimated`: plays spread over days it didn't refresh. */
export type HistoryPoint = DayPoint & { pending: boolean; estimated: boolean };
/** Per bucket: pending only when every day in it is; estimated when any day is estimated or still pending. */
const flags = { pending: sql<boolean>`bool_and(${streamDaily.pending})`, estimated: sql<boolean>`bool_or(${streamDaily.estimated} or ${streamDaily.pending})` };

function bucket(granularity: 'day' | 'week' | 'month') {
  // The unit is inlined from a fixed list: as a bind parameter, the SELECT and GROUP BY expressions would differ and Postgres rejects the query.
  const unit = { week: sql.raw(`'week'`), month: sql.raw(`'month'`) };
  return granularity === 'day' ? sql<string>`${streamDaily.day}::text` : sql<string>`date_trunc(${unit[granularity]}, ${streamDaily.day})::date::text`;
}

function groupSeries(rows: SeriesRow[]) {
  const map = new Map<string, { platform: string; source: string; points: HistoryPoint[] }>();
  for (const r of rows) {
    const k = `${r.platform}|${r.source}`;
    const s = map.get(k) ?? { platform: r.platform, source: r.source, points: [] };
    s.points.push({ day: r.day, total: Number(r.total), delta: Number(r.delta), pending: Boolean(r.pending), estimated: Boolean(r.estimated) && !r.pending });
    map.set(k, s);
  }
  return [...map.values()];
}

/**
 * The first day each series has data. That day holds a running total but no
 * plays figure (growth counts from the second reading), so charts and agents
 * show it as "no figure" rather than 0.
 */
async function seriesStarts(ctx: ServiceContext, trackIds: string[]) {
  if (trackIds.length === 0) return () => null;
  const rows = await ctx.tx
    .select({ platform: streamDaily.platform, source: streamDaily.source, first: sql<string>`min(${streamDaily.day})::text` })
    .from(streamDaily)
    .where(inArray(streamDaily.trackId, trackIds))
    .groupBy(streamDaily.platform, streamDaily.source);
  return (platform: string, source: string) => rows.find((r) => r.platform === platform && r.source === source)?.first ?? null;
}

/** The tracks an artist is on, as lead or featured artist or on the release. */
const artistTrackIds = async (ctx: ServiceContext, artistId: string) => (await creditedTracks(ctx, [artistId])).get(artistId) ?? [];

/** GET /v1/streams/tracks/:id — one series per platform and source; sources are never merged. */
export async function trackHistory(ctx: ServiceContext, trackId: string, q: Partial<z.infer<typeof HistoryQuery>> = {}) {
  ctx.assert('streams:read');
  const granularity = q.granularity ?? 'day';
  const b = bucket(granularity);
  const [rows, start] = await Promise.all([
    ctx.tx
      .select({ platform: streamDaily.platform, source: streamDaily.source, day: b, total: sql<number>`max(${streamDaily.total})::bigint`, delta: sql<number>`sum(${streamDaily.delta})::bigint`, ...flags })
      .from(streamDaily)
      .where(and(eq(streamDaily.trackId, trackId), gte(streamDaily.day, q.from ?? daysAgo(90)), lte(streamDaily.day, q.to ?? today()), q.platform ? eq(streamDaily.platform, q.platform) : undefined))
      .groupBy(streamDaily.platform, streamDaily.source, b)
      .orderBy(b),
    seriesStarts(ctx, [trackId]),
  ]);
  return { trackId, granularity, series: groupSeries(rows).map((s) => ({ ...s, since: start(s.platform, s.source) })) };
}

/** GET /v1/streams/artists/:id — plays per day across the artist's tracks, plus their top tracks. */
export async function artistHistory(ctx: ServiceContext, artistId: string, q: Partial<z.infer<typeof HistoryQuery>> = {}) {
  ctx.assert('streams:read');
  const granularity = q.granularity ?? 'day';
  const b = bucket(granularity);
  const trackIds = await artistTrackIds(ctx, artistId);
  if (trackIds.length === 0) return { artistId, granularity, series: [], topTracks: [] };
  const where = and(inArray(streamDaily.trackId, trackIds), gte(streamDaily.day, q.from ?? daysAgo(90)), lte(streamDaily.day, q.to ?? today()), q.platform ? eq(streamDaily.platform, q.platform) : undefined);
  const [rows, top, start] = await Promise.all([
    ctx.tx
      .select({ platform: streamDaily.platform, source: streamDaily.source, day: b, total: sql<number>`sum(${streamDaily.total})::bigint`, delta: sql<number>`sum(${streamDaily.delta})::bigint`, ...flags })
      .from(streamDaily)
      .where(where)
      .groupBy(streamDaily.platform, streamDaily.source, b)
      .orderBy(b),
    ctx.tx
      .select({ trackId: streamDaily.trackId, title: tracks.title, plays: sql<number>`sum(${streamDaily.delta})::bigint` })
      .from(streamDaily)
      .innerJoin(tracks, eq(tracks.id, streamDaily.trackId))
      .where(and(where, sql`${streamDaily.source} in ${polled}`))
      .groupBy(streamDaily.trackId, tracks.title)
      .orderBy(sql`3 desc`)
      .limit(10),
    seriesStarts(ctx, trackIds),
  ]);
  return { artistId, granularity, series: groupSeries(rows).map((s) => ({ ...s, since: start(s.platform, s.source) })), topTracks: top.map((t) => ({ ...t, plays: Number(t.plays) })) };
}

export const MoversQuery = z.object({ window: z.enum(['7d', '28d']).default('7d'), limit: z.coerce.number().int().min(1).max(100).default(20) });

/** GET /v1/streams/movers — biggest change in plays versus the previous window, polled sources only. */
export async function movers(ctx: ServiceContext, q: Partial<z.infer<typeof MoversQuery>> = {}) {
  ctx.assert('streams:read');
  const days = q.window === '28d' ? 28 : 7;
  const rows = await ctx.tx
    .select({
      trackId: streamDaily.trackId,
      title: tracks.title,
      current: sql<number>`coalesce(sum(${streamDaily.delta}) filter (where ${streamDaily.day} > ${daysAgo(days)}), 0)::bigint`,
      previous: sql<number>`coalesce(sum(${streamDaily.delta}) filter (where ${streamDaily.day} <= ${daysAgo(days)}), 0)::bigint`,
      previousDays: sql<number>`count(*) filter (where ${streamDaily.day} <= ${daysAgo(days)})::int`,
    })
    .from(streamDaily)
    .innerJoin(tracks, eq(tracks.id, streamDaily.trackId))
    .where(and(gte(streamDaily.day, daysAgo(days * 2 - 1)), sql`${streamDaily.source} in ${polled}`))
    .groupBy(streamDaily.trackId, tracks.title);
  const names = await artistNames(ctx, rows.map((r) => r.trackId));
  const all = rows.map((r) => {
    const current = Number(r.current);
    const previous = Number(r.previous);
    // No readings before this window: the "change" is the track starting to be tracked, not a real gain.
    return { trackId: r.trackId, title: r.title, artists: names.get(r.trackId) ?? [], current, previous, change: current - previous, changePct: previous > 0 ? ((current - previous) / previous) * 100 : null, newlyTracked: r.previousDays === 0 };
  });
  const limit = q.limit ?? 20;
  return {
    window: `${days}d`,
    gainers: all.filter((r) => r.change > 0).sort((a, b) => b.change - a.change).slice(0, limit),
    decliners: all.filter((r) => r.change < 0).sort((a, b) => a.change - b.change).slice(0, limit),
  };
}

/** Streams overview: 28-day plays and trend by platform, tracking health, open alerts. */
export async function overview(ctx: ServiceContext) {
  ctx.assert('streams:read');
  const [byPlatform, daily, statuses, pendingMatches, openAlerts, lastDay, statementPeriod] = await Promise.all([
    ctx.tx
      .select({ platform: streamDaily.platform, current: sql<number>`coalesce(sum(${streamDaily.delta}) filter (where ${streamDaily.day} > ${daysAgo(28)}), 0)::bigint`, previous: sql<number>`coalesce(sum(${streamDaily.delta}) filter (where ${streamDaily.day} <= ${daysAgo(28)}), 0)::bigint` })
      .from(streamDaily)
      .where(and(gte(streamDaily.day, daysAgo(55)), sql`${streamDaily.source} in ${polled}`))
      .groupBy(streamDaily.platform),
    ctx.tx
      .select({ day: sql<string>`${streamDaily.day}::text`, platform: streamDaily.platform, plays: sql<number>`sum(${streamDaily.delta})::bigint` })
      .from(streamDaily)
      .where(and(gte(streamDaily.day, daysAgo(90)), sql`${streamDaily.source} in ${polled}`))
      .groupBy(streamDaily.day, streamDaily.platform)
      .orderBy(streamDaily.day),
    ctx.tx.select({ status: streamTracks.status, n: sql<number>`count(*)::int` }).from(streamTracks).groupBy(streamTracks.status),
    ctx.tx.select({ n: sql<number>`count(*)::int` }).from(platformIdentities).where(and(eq(platformIdentities.platform, 'youtube'), eq(platformIdentities.status, 'pending_review'))),
    ctx.tx.select({ n: sql<number>`count(*)::int` }).from(alerts).where(isNull(alerts.acknowledgedAt)),
    ctx.tx.select({ day: sql<string | null>`max(${streamDaily.day})::text` }).from(streamDaily).where(sql`${streamDaily.source} in ${polled}`),
    ctx.tx.select({ day: sql<string | null>`max(${streamDaily.day})::text`, units: sql<number>`coalesce(sum(${streamDaily.delta}) filter (where ${streamDaily.day} = (select max(day) from stream_daily where source = 'statement-import')), 0)::bigint` }).from(streamDaily).where(eq(streamDaily.source, 'statement-import')),
  ]);
  const current = byPlatform.reduce((a, p) => a + Number(p.current), 0);
  const previous = byPlatform.reduce((a, p) => a + Number(p.previous), 0);
  const count = (s: string) => statuses.find((x) => x.status === s)?.n ?? 0;
  return {
    plays28d: current,
    previous28d: previous,
    changePct: previous > 0 ? ((current - previous) / previous) * 100 : null,
    byPlatform: byPlatform.map((p) => ({ platform: p.platform, current: Number(p.current), previous: Number(p.previous) })).sort((a, b) => b.current - a.current),
    daily: daily.map((d) => ({ day: d.day, platform: d.platform, plays: Number(d.plays) })),
    tracking: { tracking: count('tracking'), pendingMatch: count('pending_match'), paused: count('paused') },
    pendingMatches: pendingMatches[0]?.n ?? 0,
    openAlerts: openAlerts[0]?.n ?? 0,
    throughDay: lastDay[0]?.day ?? null,
    statement: statementPeriod[0]?.day ? { periodEnd: statementPeriod[0].day, units: Number(statementPeriod[0].units) } : null,
  };
}

/**
 * People's "Streams 28d" column: polled plays across every track each artist
 * is on. A collaboration counts in full for each of its artists.
 */
export async function plays28dByArtist(ctx: ServiceContext, artistIds: string[]) {
  if (artistIds.length === 0 || !ctx.can('streams:read')) return [];
  const credited = await creditedTracks(ctx, artistIds);
  const trackIds = [...new Set([...credited.values()].flat())];
  if (trackIds.length === 0) return [];
  const rows = await ctx.tx
    .select({ trackId: streamDaily.trackId, plays: sql<number>`sum(${streamDaily.delta})::bigint` })
    .from(streamDaily)
    .where(and(inArray(streamDaily.trackId, trackIds), gte(streamDaily.day, daysAgo(27)), sql`${streamDaily.source} in ${polled}`))
    .groupBy(streamDaily.trackId);
  const byTrack = new Map(rows.map((r) => [r.trackId, Number(r.plays)]));
  return [...credited]
    .map(([artistId, ids]) => ({ artistId, plays: ids.reduce((a, id) => a + (byTrack.get(id) ?? 0), 0), tracked: ids.some((id) => byTrack.has(id)) }))
    .filter((r) => r.tracked)
    .map(({ artistId, plays }) => ({ artistId, plays }));
}

/** Tracks whose YouTube views were already read through Apify today (it bills per video, so once a day is the rule). */
export async function youtubeScrapedToday(ctx: ServiceContext, trackIds: string[]) {
  if (trackIds.length === 0) return new Set<string>();
  const rows = await ctx.tx
    .selectDistinct({ trackId: streamDaily.trackId })
    .from(streamDaily)
    .where(and(inArray(streamDaily.trackId, trackIds), eq(streamDaily.source, 'youtube-scraper'), eq(streamDaily.day, new Date().toISOString().slice(0, 10))));
  return new Set(rows.map((r) => r.trackId));
}

/** Which of these Spotify track or release IDs are in the catalogue (confirmed matches), keyed by Spotify ID. */
export async function catalogueBySpotifyIds(ctx: ServiceContext, entity: 'track' | 'release', spotifyIds: string[]) {
  const out = new Map<string, { id: string; title: string }>();
  if (spotifyIds.length === 0) return out;
  const target = entity === 'track' ? tracks : releases;
  const rows = await ctx.tx
    .select({ externalId: platformIdentities.externalId, id: target.id, title: target.title })
    .from(platformIdentities)
    .innerJoin(target, eq(target.id, platformIdentities.entityId))
    .where(and(eq(platformIdentities.entityType, entity), eq(platformIdentities.platform, 'spotify'), eq(platformIdentities.status, 'confirmed'), inArray(platformIdentities.externalId, spotifyIds)));
  for (const r of rows) out.set(r.externalId, { id: r.id, title: r.title });
  return out;
}

/** Catalogue lists: each track's latest Spotify play count and the plays it gained over the last 7 days. */
/**
 * Each track's all-time count and last 7 days per platform (Spotify plays,
 * YouTube Music plays, YouTube video views), for catalogue lists.
 */
export async function playsByTrack(ctx: ServiceContext, trackIds: string[]) {
  if (trackIds.length === 0 || !ctx.can('streams:read')) return [];
  const [latest, week] = await Promise.all([
    ctx.tx
      .selectDistinctOn([streamDaily.trackId, streamDaily.platform], { trackId: streamDaily.trackId, platform: streamDaily.platform, total: streamDaily.total, day: sql<string>`${streamDaily.day}::text` })
      .from(streamDaily)
      .where(and(inArray(streamDaily.trackId, trackIds), sql`${streamDaily.source} in ${polled}`))
      .orderBy(streamDaily.trackId, streamDaily.platform, desc(streamDaily.day)),
    ctx.tx
      .select({ trackId: streamDaily.trackId, platform: streamDaily.platform, plays: sql<number>`sum(${streamDaily.delta})::bigint`, days: sql<number>`count(*)::int` })
      .from(streamDaily)
      .where(and(inArray(streamDaily.trackId, trackIds), sql`${streamDaily.source} in ${polled}`, gte(streamDaily.day, daysAgo(6))))
      .groupBy(streamDaily.trackId, streamDaily.platform),
  ]);
  return latest.map((l) => {
    const w = week.find((x) => x.trackId === l.trackId && x.platform === l.platform);
    // The first day of tracking has no delta yet, so a week with a single reading is not a gain of zero.
    return { trackId: l.trackId, platform: l.platform, total: Number(l.total), plays7d: w && w.days > 1 ? Number(w.plays) : null, asOf: l.day };
  });
}

/* ------------------------------------------------------------ alerts --- */

export async function ensureDefaultRules(ctx: ServiceContext) {
  const [existing] = await ctx.tx.select({ n: sql<number>`count(*)::int` }).from(alertRules);
  if ((existing?.n ?? 0) > 0) return;
  await ctx.tx.insert(alertRules).values(DEFAULT_RULES.map((r) => ({ name: r.name, kind: r.kind, threshold: String(r.threshold), windowDays: r.windowDays, minDaily: r.minDaily, platform: r.platform })));
}

export async function listRules(ctx: ServiceContext) {
  ctx.assert('streams:read');
  await ensureDefaultRules(ctx);
  return ctx.tx.select().from(alertRules).orderBy(asc(alertRules.kind), asc(alertRules.threshold));
}

export const RuleInput = z.object({
  name: z.string().trim().min(1).max(120),
  kind: z.enum(ALERT_KINDS),
  threshold: z.number().positive().max(1e12),
  windowDays: z.number().int().min(3).max(60).default(7),
  minDaily: z.number().int().min(0).max(1e9).default(100),
  platform: z.string().max(40).nullable().optional(),
  enabled: z.boolean().default(true),
});

export const RulePatch = patchOf(RuleInput);

export async function createRule(ctx: ServiceContext, input: z.input<typeof RuleInput>) {
  ctx.assert('streams:manage');
  const r = RuleInput.parse(input);
  const [row] = await ctx.tx.insert(alertRules).values({ ...r, threshold: String(r.threshold), platform: r.platform ?? null }).returning();
  await ctx.audit({ action: 'streams.rule_created', module: 'streams', targetType: 'alert_rule', targetId: row.id, targetLabel: row.name, after: r });
  return row;
}

export async function updateRule(ctx: ServiceContext, id: string, patch: z.input<typeof RulePatch>) {
  ctx.assert('streams:manage');
  const p = RulePatch.parse(patch);
  const [before] = await ctx.tx.select().from(alertRules).where(eq(alertRules.id, id));
  if (!before) throw new NotFoundError('Alert rule');
  const [row] = await ctx.tx.update(alertRules).set({ ...p, threshold: p.threshold != null ? String(p.threshold) : undefined }).where(eq(alertRules.id, id)).returning();
  await ctx.audit({ action: 'streams.rule_updated', module: 'streams', targetType: 'alert_rule', targetId: id, targetLabel: row.name, before: before as never, after: row as never });
  return row;
}

export async function deleteRule(ctx: ServiceContext, id: string) {
  ctx.assert('streams:manage');
  const [row] = await ctx.tx.delete(alertRules).where(eq(alertRules.id, id)).returning();
  if (row) await ctx.audit({ action: 'streams.rule_deleted', module: 'streams', targetType: 'alert_rule', targetId: id, targetLabel: row.name });
}

/**
 * Check a track's series against the rules after new data. Spikes and drops
 * look at yesterday (the last complete day); milestones at the latest reading.
 */
export async function evaluateTrackAlerts(ctx: ServiceContext, trackId: string, platform: string, source: StreamSource) {
  const rules = (await ctx.tx.select().from(alertRules).where(eq(alertRules.enabled, true))).map((r) => ({ id: r.id, kind: r.kind as AlertKind, threshold: Number(r.threshold), windowDays: r.windowDays, minDaily: r.minDaily, platform: r.platform }));
  if (rules.length === 0) return [];
  const maxWindow = Math.max(7, ...rules.map((r) => r.windowDays));
  const points = (
    await ctx.tx
      .select({ day: sql<string>`${streamDaily.day}::text`, total: streamDaily.total, delta: streamDaily.delta })
      .from(streamDaily)
      // A pending day (the platform hasn't refreshed yet) is not a drop, and isn't part of anyone's baseline.
      .where(and(eq(streamDaily.trackId, trackId), eq(streamDaily.platform, platform), eq(streamDaily.source, source), eq(streamDaily.pending, false), gte(streamDaily.day, daysAgo(maxWindow + 2))))
      .orderBy(streamDaily.day)
  ).map((p) => ({ day: p.day, total: Number(p.total), delta: Number(p.delta) }));
  const hits = evaluateRules(rules, platform, points, daysAgo(1));
  if (hits.length === 0) return [];
  const [track] = await ctx.tx.select({ title: tracks.title }).from(tracks).where(eq(tracks.id, trackId));
  const created = [];
  for (const h of hits) {
    const [row] = await ctx.tx.insert(alerts).values({ ruleId: h.ruleId, trackId, kind: h.kind, platform, day: h.day, value: h.value, baseline: h.baseline, message: h.message }).onConflictDoNothing().returning();
    if (!row) continue;
    created.push(row);
    await ctx.emit('streams.alert', { alertId: row.id, trackId, trackTitle: track?.title ?? 'Track', kind: h.kind, platform, message: h.message, value: h.value });
  }
  return created;
}

export const AlertQuery = z.object({ open: z.enum(['1', '0']).optional(), trackId: z.uuid().optional() });

export async function listAlerts(ctx: ServiceContext, q: z.infer<typeof AlertQuery> = {}) {
  ctx.assert('streams:read');
  const rows = await ctx.tx
    .select({ alert: alerts, title: tracks.title })
    .from(alerts)
    .innerJoin(tracks, eq(tracks.id, alerts.trackId))
    .where(and(q.open === '1' ? isNull(alerts.acknowledgedAt) : undefined, q.trackId ? eq(alerts.trackId, q.trackId) : undefined))
    .orderBy(desc(alerts.createdAt))
    .limit(300);
  const names = await artistNames(ctx, [...new Set(rows.map((r) => r.alert.trackId))]);
  return rows.map((r) => ({ ...r.alert, trackTitle: r.title, artists: names.get(r.alert.trackId) ?? [] }));
}

export async function acknowledgeAlert(ctx: ServiceContext, id: string) {
  ctx.assert('streams:read');
  const by = ctx.actor.type === 'system' ? 'system' : `${ctx.actor.type}:${ctx.actor.id}`;
  const [row] = await ctx.tx.update(alerts).set({ acknowledgedAt: new Date(), acknowledgedBy: by }).where(and(eq(alerts.id, id), isNull(alerts.acknowledgedAt))).returning();
  return row ?? null;
}

/** Derived numbers for agents: never raw provider payloads, only the daily figures stored here. */
export async function historyForAgent(ctx: ServiceContext, input: { trackId?: string; artistId?: string; days: number }) {
  const from = daysAgo(input.days);
  const h = input.trackId ? await trackHistory(ctx, input.trackId, { from }) : await artistHistory(ctx, input.artistId!, { from });
  // The day tracking began has a running total but no plays figure yet; reporting it as 0 reads as a dead day.
  const firstDay = await seriesStarts(ctx, input.trackId ? [input.trackId] : await artistTrackIds(ctx, input.artistId!));
  return h.series.map((s) => {
    const first = firstDay(s.platform, s.source);
    const plays = s.points.reduce((a, p) => a + p.delta, 0);
    const last7 = s.points.filter((p) => p.day > daysAgo(7)).reduce((a, p) => a + p.delta, 0);
    const prev7 = s.points.filter((p) => p.day <= daysAgo(7) && p.day > daysAgo(14)).reduce((a, p) => a + p.delta, 0);
    return {
      platform: s.platform,
      source: s.source,
      kind: s.source === 'statement-import' ? 'units per statement period' : 'plays per day',
      trackedSince: first,
      total: s.points.at(-1)?.total ?? null,
      playsInWindow: plays,
      last7Days: last7,
      previous7Days: prev7,
      // Pending: the platform hasn't refreshed its count yet, so the day has no figure (it is not a day with 0 plays).
      points: s.points.slice(-60).map((p) => ({ day: p.day, value: s.source === 'statement-import' ? p.total : p.day === first || p.pending ? null : p.delta, ...(p.pending ? { pending: true } : p.estimated ? { estimated: true } : {}) })),
    };
  });
}

/** Which sources can run for this label, for the overview's setup notes. */
export async function sourceStatus(ctx: ServiceContext) {
  const rows = await ctx.tx.select({ provider: credentials.provider, metadata: credentials.metadata }).from(credentials).where(and(inArray(credentials.provider, ['youtube', 'licensed_streams']), isNull(credentials.revokedAt)));
  const youtubeKey = rows.some((r) => r.provider === 'youtube') || Boolean(env().YOUTUBE_API_KEY);
  // Without a key, YouTube views come through Apify once a day when the label has a token.
  const youtubeViaApify = !youtubeKey && (await apifyConfigured(ctx));
  return {
    youtube: youtubeKey || youtubeViaApify,
    youtubeViaApify,
    youtubePlatformKey: !rows.some((r) => r.provider === 'youtube') && Boolean(env().YOUTUBE_API_KEY),
    spotify: await spotScraperConfigured(ctx),
    licensed: rows.some((r) => r.provider === 'licensed_streams'),
  };
}

/* -------------------------------------------------- spotify audience --- */

export type ArtistStatsInput = { artistId: string; spotifyArtistId: string; day: string; monthlyListeners: number | null; followers: number | null; worldRank: number | null; topCities: TopCity[]; discoveredOn: DiscoveredOn[] };

/** Queue a reading of one artist's Spotify audience, when they have a Spotify artist ID and a key is set. */
export async function requestArtistAudience(ctx: ServiceContext, artistId: string) {
  const [a] = await ctx.tx.select({ spotifyArtistId: artists.spotifyArtistId }).from(artists).where(eq(artists.id, artistId));
  if (!a?.spotifyArtistId || !(await spotScraperConfigured(ctx))) return;
  enqueueAfterCommit(ctx, 'streams.audience', { artistIds: [artistId] }, { jobId: `audience-${artistId}-${Date.now().toString(36)}`, attempts: 3, backoff: { type: 'exponential', delay: 60_000 } });
}

/**
 * Link roster artists to their Spotify profiles from the artists Spotify
 * lists on their tracks. An artist without a Spotify ID gets one when they are
 * on the track and their name (or an alias) matches exactly one of its Spotify
 * artists. A profile another roster artist already holds is never given out
 * twice. Linking reads the artist's audience straight away (the
 * people.artist.updated listener). Returns the artists linked.
 */
export async function linkSpotifyArtists(ctx: ServiceContext, found: TrackArtistRefs[]): Promise<Array<{ artistId: string; spotifyArtistId: string }>> {
  const reads = found.filter((f) => f.artists.length);
  if (reads.length === 0) return [];
  const on = await artistsOnTrack(ctx, [...new Set(reads.map((f) => f.trackId))]);
  const ids = [...new Set([...on.values()].flat().map((a) => a.id))];
  if (ids.length === 0) return [];
  const [roster, holders] = await Promise.all([
    ctx.tx.select({ id: artists.id, name: artists.name, aliases: artists.aliases, spotifyArtistId: artists.spotifyArtistId }).from(artists).where(inArray(artists.id, ids)),
    ctx.tx.select({ spotifyArtistId: artists.spotifyArtistId }).from(artists).where(isNotNull(artists.spotifyArtistId)),
  ]);
  const taken = new Set(holders.map((h) => spotifyIdFrom(h.spotifyArtistId, 'artist')).filter(Boolean));
  const linked: Array<{ artistId: string; spotifyArtistId: string }> = [];
  for (const a of roster) {
    if (spotifyIdFrom(a.spotifyArtistId, 'artist')) continue;
    const keys = new Set([a.name, ...a.aliases].map(normName).filter(Boolean));
    const matches = new Set<string>();
    for (const f of reads) {
      if (!(on.get(f.trackId) ?? []).some((x) => x.id === a.id)) continue;
      for (const s of f.artists) if (keys.has(normName(s.name)) && spotifyIdFrom(s.id, 'artist')) matches.add(s.id);
    }
    // No match, or two Spotify profiles with the same name: that one is for staff to pick.
    if (matches.size !== 1) continue;
    const [spotifyArtistId] = matches;
    if (taken.has(spotifyArtistId)) continue;
    await updateArtist(ctx, a.id, { spotifyArtistId });
    taken.add(spotifyArtistId);
    linked.push({ artistId: a.id, spotifyArtistId });
  }
  return linked;
}

/**
 * For artists without a Spotify profile: up to three of their tracks to read
 * on Spotify, confirmed Spotify IDs first (one request each), then ISRCs to
 * search. Artists on no Spotify track are left out.
 */
export async function spotifyLinkPlan(ctx: ServiceContext, artistIds?: string[]) {
  const roster = await ctx.tx
    .select({ id: artists.id, name: artists.name, aliases: artists.aliases, spotifyArtistId: artists.spotifyArtistId })
    .from(artists)
    .where(artistIds?.length ? inArray(artists.id, artistIds) : undefined);
  const unlinked = roster.filter((a) => !spotifyIdFrom(a.spotifyArtistId, 'artist'));
  if (unlinked.length === 0) return [];
  const credited = await creditedTracks(ctx, unlinked.map((a) => a.id));
  const trackIds = [...new Set([...credited.values()].flat())];
  if (trackIds.length === 0) return [];
  const [identities, codes] = await Promise.all([
    ctx.tx
      .select({ trackId: platformIdentities.entityId, externalId: platformIdentities.externalId, variant: platformIdentities.variant })
      .from(platformIdentities)
      .where(and(eq(platformIdentities.entityType, 'track'), inArray(platformIdentities.entityId, trackIds), eq(platformIdentities.platform, 'spotify'), eq(platformIdentities.status, 'confirmed'))),
    ctx.tx.select({ id: tracks.id, isrc: tracks.isrc }).from(tracks).where(and(inArray(tracks.id, trackIds), isNotNull(tracks.isrc))),
  ]);
  const spotifyOf = new Map<string, string>();
  for (const i of [...identities].sort((a, b) => Number(b.variant === 'primary') - Number(a.variant === 'primary'))) if (!spotifyOf.has(i.trackId)) spotifyOf.set(i.trackId, i.externalId);
  const isrcOf = new Map(codes.map((c) => [c.id, c.isrc!]));
  return unlinked
    .map((a) => {
      const mine = credited.get(a.id) ?? [];
      const reads = [
        ...mine.filter((t) => spotifyOf.has(t)).map((t) => ({ trackId: t, spotifyId: spotifyOf.get(t)!, isrc: null })),
        ...mine.filter((t) => !spotifyOf.has(t) && isrcOf.has(t)).map((t) => ({ trackId: t, spotifyId: null, isrc: isrcOf.get(t)! })),
      ].slice(0, 3);
      return { artistId: a.id, names: [a.name, ...a.aliases], reads };
    })
    .filter((p) => p.reads.length > 0);
}

/** For an artist's audience panel: linked or not, whether a key is set, and how many of their tracks Spotify can be read through. */
export async function spotifyLinkState(ctx: ServiceContext, artistId: string) {
  const [a] = await ctx.tx.select({ spotifyArtistId: artists.spotifyArtistId }).from(artists).where(eq(artists.id, artistId));
  const linked = Boolean(spotifyIdFrom(a?.spotifyArtistId, 'artist'));
  const [spotScraper, plan] = await Promise.all([spotScraperConfigured(ctx), linked ? Promise.resolve([]) : spotifyLinkPlan(ctx, [artistId])]);
  return { linked, spotScraper, spotifyTracks: plan[0]?.reads.length ?? 0 };
}

/** Queue a search for Spotify profiles (one artist, or every artist without one). */
export async function requestSpotifyArtistLink(ctx: ServiceContext, artistIds?: string[]) {
  ctx.assert('people:write');
  if (!(await spotScraperConfigured(ctx))) throw new ValidationError('Finding Spotify profiles needs a SpotScraper key. Add one under Settings → Integrations.');
  enqueueAfterCommit(ctx, 'streams.link-artists', { artistIds }, { jobId: `link-artists-${Date.now().toString(36)}`, attempts: 1 });
  return { queued: true };
}

/** Each artist's latest monthly listeners, for lists. */
export async function latestListenersByArtist(ctx: ServiceContext, artistIds: string[]) {
  if (artistIds.length === 0 || !ctx.can('streams:read')) return [];
  return ctx.tx
    .selectDistinctOn([artistSpotifyStats.artistId], { artistId: artistSpotifyStats.artistId, monthlyListeners: artistSpotifyStats.monthlyListeners, day: artistSpotifyStats.day })
    .from(artistSpotifyStats)
    .where(inArray(artistSpotifyStats.artistId, artistIds))
    .orderBy(artistSpotifyStats.artistId, desc(artistSpotifyStats.day));
}

/** One row per artist per day; a second reading the same day replaces the first. */
export async function recordArtistStats(ctx: ServiceContext, rows: ArtistStatsInput[]) {
  for (const r of rows) {
    const values = { ...r, topCities: r.topCities.slice(0, 10), discoveredOn: r.discoveredOn.slice(0, 50), capturedAt: new Date() };
    await ctx.tx
      .insert(artistSpotifyStats)
      .values(values)
      .onConflictDoUpdate({ target: [artistSpotifyStats.orgId, artistSpotifyStats.artistId, artistSpotifyStats.day], set: values });
  }
}

/** An artist's Spotify audience: the latest reading, the change over 28 days, and 90 days of monthly listeners. */
export async function artistAudience(ctx: ServiceContext, artistId: string) {
  ctx.assert('streams:read');
  const rows = await ctx.tx
    .select()
    .from(artistSpotifyStats)
    .where(and(eq(artistSpotifyStats.artistId, artistId), gte(artistSpotifyStats.day, daysAgo(90))))
    .orderBy(asc(artistSpotifyStats.day));
  const latest = rows.at(-1) ?? null;
  if (!latest) return null;
  // The reading closest to 28 days before the latest one.
  const target = new Date(Date.parse(`${latest.day}T00:00:00Z`) - 28 * 86400_000).toISOString().slice(0, 10);
  const before = rows.filter((r) => r.day <= target).at(-1) ?? null;
  const change = (a: number | null | undefined, b: number | null | undefined) => (a != null && b != null ? a - b : null);
  return {
    day: latest.day,
    spotifyArtistId: latest.spotifyArtistId,
    monthlyListeners: latest.monthlyListeners,
    followers: latest.followers,
    worldRank: latest.worldRank,
    listenersChange28d: change(latest.monthlyListeners, before?.monthlyListeners),
    followersChange28d: change(latest.followers, before?.followers),
    comparedTo: before?.day ?? null,
    topCities: latest.topCities,
    discoveredOn: latest.discoveredOn,
    series: rows.filter((r) => r.monthlyListeners != null).map((r) => ({ day: r.day, monthlyListeners: r.monthlyListeners!, followers: r.followers })),
  };
}

/** Every artist on a track, lead artists first, for tools that start from a track. */
export async function trackArtistIds(ctx: ServiceContext, trackId: string) {
  return ((await artistsOnTrack(ctx, [trackId])).get(trackId) ?? []).map((a) => a.id);
}

/** For agents: the audience numbers only (no playlist owners' account names). */
export async function audienceForAgent(ctx: ServiceContext, artistId: string) {
  const a = await artistAudience(ctx, artistId);
  if (!a) return null;
  return {
    asOf: a.day,
    monthlyListeners: a.monthlyListeners,
    monthlyListenersChange28d: a.listenersChange28d,
    followers: a.followers,
    followersChange28d: a.followersChange28d,
    worldRank: a.worldRank,
    topCities: a.topCities.map((c) => ({ city: c.city, country: c.country, listeners: c.listeners })),
    discoveredOnPlaylists: a.discoveredOn.slice(0, 20).map((p) => ({ name: p.name, curator: p.owner && /^[a-z0-9]{20,}$/.test(p.owner) ? null : p.owner, spotifyUrl: `https://open.spotify.com/playlist/${p.id}` })),
  };
}

/** Register catalogue tracks the tracker doesn't know yet (created before Streams was switched on). */
export async function backfillRegistry(ctx: ServiceContext, limit = 200) {
  // At the plan's tracking limit there's nothing to add until a track is paused or the plan grows.
  const room = (await planOf(ctx)).limits.trackedTracks - (await activeTrackCount(ctx));
  if (room <= 0) return 0;
  const missing = await ctx.tx
    .select({ id: tracks.id })
    .from(tracks)
    .where(sql`not exists (select 1 from stream_tracks st where st.track_id = ${tracks.id})`)
    .limit(Math.min(limit, room));
  for (const t of missing) await registerTrack(ctx, t.id);
  return missing.length;
}

/**
 * Plays (polled sources) for a set of tracks between two days, by day.
 * Marketing uses it for a campaign's stream delta.
 */
export async function playsForTracks(ctx: ServiceContext, trackIds: string[], from: string, to: string) {
  if (trackIds.length === 0 || !ctx.can('streams:read')) return { total: 0, daily: [] as Array<{ day: string; plays: number }> };
  const rows = await ctx.tx
    .select({ day: sql<string>`${streamDaily.day}::text`, plays: sql<number>`sum(${streamDaily.delta})::bigint` })
    .from(streamDaily)
    .where(and(inArray(streamDaily.trackId, trackIds), gte(streamDaily.day, from), lte(streamDaily.day, to), sql`${streamDaily.source} in ${polled}`))
    .groupBy(streamDaily.day)
    .orderBy(streamDaily.day);
  const daily = rows.map((r) => ({ day: r.day, plays: Number(r.plays) }));
  return { total: daily.reduce((a, d) => a + d.plays, 0), daily };
}
