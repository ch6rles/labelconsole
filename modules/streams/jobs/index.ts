import '../types';
import { createHmac } from 'node:crypto';
import { and, eq, inArray, isNotNull, isNull, lte, or, sql } from 'drizzle-orm';
import { apifyFor, type ApifyClient } from '@labelconsole/core/apify';
import { withSystemOrg } from '@labelconsole/core/context';
import { systemDb } from '@labelconsole/core/db/client';
import { organizations } from '@labelconsole/core/db/schema';
import { env } from '@labelconsole/core/env';
import { isTransient, RateLimitedError } from '@labelconsole/core/errors';
import { enabledModuleIds } from '@labelconsole/core/modules';
import { isPublicHttps } from '@labelconsole/core/net';
import { defineJob, enqueue, type JobContext } from '@labelconsole/core/queue';
import { normName, pickIsrcMatch, spotifyIdFrom, spotScraperFor, type SpotScraperClient } from '@labelconsole/core/spotscraper';
import { recordUsage } from '@labelconsole/core/usage';
import { readSecret } from '@labelconsole/core/vault';
import { platformIdentities, tracks } from '@labelconsole/catalogue/schema';
import { artistsOnTrack, upsertIdentity } from '@labelconsole/catalogue/service';
import { documents, statementLines } from '@labelconsole/documents/schema';
import { artists } from '@labelconsole/people/schema';
import { streamTracks } from '../schema';
import { licensedAdapter, licensedStreamProvider, type LicensedStreamSecret } from '../sources/licensed';
import { spotifyAdapter } from '../sources/spotify';
import { statementPeriodTotals } from '../sources/statements';
import type { Snapshot, TrackRef } from '../sources/types';
import { fetchViewsApify, searchVideosApify } from '../sources/youtube-apify';
import { AUTO_CONFIRM, REVIEW, scoreCandidates, searchVideos, youtubeAdapter, type SearchCandidate } from '../sources/youtube';
import {
  activeTrackIds,
  backfillRegistry,
  confirmedVideos,
  ensureDefaultRules,
  evaluateTrackAlerts,
  linkSpotifyArtists,
  nextPollAt,
  pollableTrackIds,
  promoteSpotifyPrimaries,
  recordArtistStats,
  recordSnapshots,
  youtubeScrapedToday,
  registerTrack,
  rollupStatementCounts,
  spotifyLinkPlan,
  spotifyPrimaries,
  type ArtistStatsInput,
} from '../service';
import type { TrackArtistRefs } from '../sources/types';

export const NO_YOUTUBE_KEY = 'Add a YouTube Data API key (free) or an Apify token under Settings → Integrations to track YouTube views';
export const NO_SPOTSCRAPER_KEY = 'Add a SpotScraper key under Settings → Integrations to track Spotify plays';
const POLL_SLOT_MS = 15 * 60_000;
/** An ISRC with no Spotify match is searched again after this long. */
const SPOTIFY_RECHECK_MS = 7 * 86400_000;

async function youtubeKey(job: JobContext) {
  const s = await job.withOrg((ctx) => readSecret(ctx, 'youtube'));
  return s?.secret.apiKey || env().YOUTUBE_API_KEY || null;
}

/** How YouTube is read for this label: the free Data API when it has a key, else Apify when it has a token. */
async function youtubeReader(job: JobContext): Promise<{ key: string } | { apify: ApifyClient } | null> {
  const key = await youtubeKey(job);
  if (key) return { key };
  const apify = await job.withOrg((ctx) => apifyFor(ctx));
  return apify ? { apify } : null;
}

/** Bill Apify results to the label's usage counters. */
async function countApify(job: JobContext, client: ApifyClient) {
  if (!client.results) return;
  const n = client.results;
  client.results = 0;
  await job.withOrg((ctx) => recordUsage(ctx, 'apify_results', n));
}

/** Bill SpotScraper requests to the label's usage counters (SpotScraper charges per request). */
async function countRequests(job: JobContext, client: SpotScraperClient) {
  const n = client.requests;
  client.requests = 0;
  if (n > 0) await job.withOrg((ctx) => recordUsage(ctx, 'spotscraper_requests', n));
}

/**
 * Find the Spotify ID to poll for tracks that have none: promote a confirmed
 * ID the catalogue already knows (free), else search the track's ISRC (once a
 * week at most for tracks with no match). IDs staff rejected are never picked.
 * Requests run outside any transaction.
 */
async function matchSpotify(job: JobContext, client: SpotScraperClient, trackIds: string[]): Promise<TrackRef[]> {
  if (trackIds.length === 0) return [];
  const pending = await job.withOrg(async (ctx) => {
    const have = await promoteSpotifyPrimaries(ctx, trackIds);
    const rest = trackIds.filter((t) => !have.has(t));
    if (rest.length === 0) return [];
    const recheck = new Date(Date.now() - SPOTIFY_RECHECK_MS);
    const rows = (await ctx.tx.select({ id: streamTracks.id, trackId: streamTracks.trackId, isrc: tracks.isrc, checkedAt: streamTracks.spotifyCheckedAt }).from(streamTracks).innerJoin(tracks, eq(tracks.id, streamTracks.trackId)).where(inArray(streamTracks.trackId, rest))).filter(
      (r) => r.isrc && (!r.checkedAt || r.checkedAt < recheck),
    );
    if (rows.length === 0) return [];
    const ids = rows.map((r) => r.trackId);
    const [names, rejected] = await Promise.all([
      artistsOnTrack(ctx, ids),
      ctx.tx.select({ trackId: platformIdentities.entityId, externalId: platformIdentities.externalId }).from(platformIdentities).where(and(eq(platformIdentities.entityType, 'track'), inArray(platformIdentities.entityId, ids), eq(platformIdentities.platform, 'spotify'), eq(platformIdentities.status, 'rejected'))),
    ]);
    return rows.map((r) => ({ ...r, isrc: r.isrc!, artists: (names.get(r.trackId) ?? []).map((n) => n.name), rejected: new Set(rejected.filter((x) => x.trackId === r.trackId).map((x) => x.externalId)) }));
  });
  const found: Array<(typeof pending)[number] & { spotifyId: string | null }> = [];
  for (const p of pending) {
    const results = await client.searchIsrc(p.isrc);
    found.push({ ...p, spotifyId: pickIsrcMatch(results.filter((r) => !p.rejected.has(r.id)), p.isrc, p.artists)?.id ?? null });
  }
  return job.withOrg(async (ctx) => {
    for (const f of found) {
      if (f.spotifyId) await upsertIdentity(ctx, { entityType: 'track', entityId: f.trackId, platform: 'spotify', externalId: f.spotifyId, url: `https://open.spotify.com/track/${f.spotifyId}`, source: 'spotscraper', confidence: 1, status: 'confirmed', variant: 'primary' });
      await ctx.tx.update(streamTracks).set({ spotifyCheckedAt: new Date() }).where(eq(streamTracks.id, f.id));
    }
    return (await spotifyPrimaries(ctx, trackIds)).map((p) => ({ trackId: p.trackId, platform: 'spotify', externalId: p.externalId }));
  });
}

async function streamsEnabled(orgId: string) {
  const [org] = await systemDb().select({ id: organizations.id, plan: organizations.plan }).from(organizations).where(eq(organizations.id, orgId));
  return org ? (await enabledModuleIds(systemDb(), org)).has('streams') : false;
}

/** Signed batch POST to the label's webhook, if it configured one. Failures are logged, never retried in a loop. */
async function sendWebhook(job: JobContext, items: unknown[]) {
  if (items.length === 0) return;
  const hook = await job.withOrg((ctx) => readSecret(ctx, 'streams_webhook'));
  if (!hook?.secret.url) return;
  if (!isPublicHttps(hook.secret.url)) {
    job.log.warn('stream webhook skipped: the URL must be a public https:// endpoint');
    return;
  }
  const body = JSON.stringify({ event: 'streams.snapshot.recorded', orgId: job.orgId, sentAt: new Date().toISOString(), items });
  const signature = createHmac('sha256', hook.secret.secret ?? '').update(body).digest('hex');
  try {
    const res = await fetch(hook.secret.url, { method: 'POST', headers: { 'content-type': 'application/json', 'user-agent': env().HTTP_USER_AGENT, 'x-labelconsole-signature': `sha256=${signature}` }, body, redirect: 'error', signal: AbortSignal.timeout(10_000) });
    if (!res.ok) job.log.warn({ status: res.status }, 'stream webhook rejected');
  } catch (err) {
    job.log.warn({ err: (err as Error).message }, 'stream webhook failed');
  }
}

export const jobs = [
  /** Every 15 minutes: queue a poll for each org with tracks due, and retry matching for unmatched tracks. */
  defineJob('streams.schedule', async (job) => {
    const now = new Date();
    const due = await systemDb()
      .selectDistinct({ orgId: streamTracks.orgId })
      .from(streamTracks)
      .where(and(eq(streamTracks.status, 'tracking'), or(isNull(streamTracks.nextPollAt), lte(streamTracks.nextPollAt, now))));
    const slot = Math.floor(now.getTime() / POLL_SLOT_MS);
    let queued = 0;
    for (const { orgId } of due) {
      if (!(await streamsEnabled(orgId))) continue;
      await enqueue('streams.poll-org', orgId, {}, { jobId: `poll-${orgId}-${slot}`, attempts: 3, backoff: { type: 'exponential', delay: 60_000 } });
      queued++;
    }
    // Tracks that entered the catalogue before Streams was switched on.
    const unregistered = (await systemDb().execute(sql`
      select distinct t.org_id from tracks t
      where not exists (select 1 from stream_tracks st where st.track_id = t.id) limit 100`)) as unknown as Array<{ org_id: string }>;
    for (const { org_id } of unregistered) {
      if (await streamsEnabled(org_id)) await withSystemOrg(org_id, (ctx) => backfillRegistry(ctx), 'job:streams.schedule');
    }
    // Unmatched tracks: search again weekly, or daily while the label has no YouTube key yet. A few per org per run keeps quota for polling.
    const stale = (await systemDb().execute(sql`
      select id, org_id from (
        select id, org_id, row_number() over (partition by org_id order by last_resolved_at nulls first) as rn
        from stream_tracks
        where status = 'pending_match'
          and (last_resolved_at is null and created_at < now() - interval '1 hour'
               or last_resolved_at < now() - case when last_error like 'Add a YouTube Data API key%' or last_error like 'YouTube search (Apify)%' then interval '1 day' else interval '7 days' end)
      ) t where rn <= 5`)) as unknown as Array<{ id: string; org_id: string }>;
    for (const s of stale) {
      if (!(await streamsEnabled(s.org_id))) continue;
      await enqueue('streams.resolve-track', s.org_id, { streamTrackId: s.id }, { jobId: `resolve-${s.id}-${Math.floor(now.getTime() / 86400_000)}`, attempts: 2 });
    }
    job.log.info({ orgs: queued, resolves: stale.length }, 'streams scheduled');
  }),

  /**
   * Find what to poll for a track: its Spotify ID by ISRC (SpotScraper), and
   * its YouTube videos by one search, scored; low-confidence videos go to review.
   */
  defineJob('streams.resolve-track', async (job, data) => {
    const info = await job.withOrg(async (ctx) => {
      const [row] = await ctx.tx.select({ st: streamTracks, title: tracks.title, durationMs: tracks.durationMs }).from(streamTracks).innerJoin(tracks, eq(tracks.id, streamTracks.trackId)).where(eq(streamTracks.id, data.streamTrackId));
      if (!row) return null;
      const names = (await artistsOnTrack(ctx, [row.st.trackId])).get(row.st.trackId) ?? [];
      // Aliases (such as the name on Spotify) count when matching channels, after the roster names.
      return { ...row, artists: [...new Set([...names.map((n) => n.name), ...names.flatMap((n) => n.aliases)])], videos: await confirmedVideos(ctx, [row.st.trackId]) };
    });
    if (!info || info.st.status === 'paused') return;
    const trackId = info.st.trackId;

    // Spotify: an exact ISRC match needs no review.
    let spotifyNote: string | null = null;
    const client = await job.withOrg((ctx) => spotScraperFor(ctx));
    if (client) {
      try {
        const refs = await matchSpotify(job, client, [trackId]);
        if (refs.length === 0) spotifyNote = 'No Spotify track found for this ISRC';
      } finally {
        await countRequests(job, client);
      }
    }

    // YouTube: one search (100 quota units) unless a video is already confirmed.
    let youtubeNote: string | null = null;
    let candidates = 0;
    let picks: Array<{ variant: string; confidence: number }> = [];
    if (info.videos.length === 0) {
      const reader = await youtubeReader(job);
      if (!reader) youtubeNote = NO_YOUTUBE_KEY;
      else {
        const q = `${info.artists[0] ?? ''} ${info.title}`.trim();
        let found: SearchCandidate[] = [];
        let searchError: string | null = null;
        if ('key' in reader) found = await searchVideos(reader.key, q);
        else {
          try {
            found = await searchVideosApify(reader.apify, q);
          } catch (err) {
            // A paid search is never retried by the queue; the scheduler tries again tomorrow.
            job.log.warn({ err: (err as Error).message, trackId }, 'youtube search via apify failed');
            searchError = `YouTube search (Apify): ${(err as Error).message.slice(0, 200)}`;
          } finally {
            await countApify(job, reader.apify);
          }
        }
        candidates = found.length;
        const verdicts = scoreCandidates({ title: info.title, artists: info.artists, durationMs: info.durationMs }, found);
        const chosen = [verdicts.find((v) => v.variant === 'topic'), verdicts.find((v) => v.variant === 'official')].filter((v): v is NonNullable<typeof v> => Boolean(v && v.confidence >= REVIEW));
        picks = chosen;
        await job.withOrg(async (ctx) => {
          for (const v of chosen) {
            await upsertIdentity(ctx, { entityType: 'track', entityId: trackId, platform: 'youtube', externalId: v.videoId, url: `https://www.youtube.com/watch?v=${v.videoId}`, source: 'key' in reader ? 'youtube-search' : 'youtube-scraper-search', confidence: v.confidence, status: v.confidence >= AUTO_CONFIRM ? 'confirmed' : 'pending_review', variant: v.variant });
          }
        });
        if (chosen.length === 0) youtubeNote = searchError ?? (candidates ? 'No confident YouTube match; paste the video link on the Matching page' : 'No YouTube video found for this track');
      }
    }

    await job.withOrg(async (ctx) => {
      const pollable = (await pollableTrackIds(ctx, [trackId])).size > 0;
      // Without a YouTube key and nothing else to poll, keep NO_YOUTUBE_KEY: the scheduler retries those daily.
      const lastError = pollable ? null : youtubeNote === NO_YOUTUBE_KEY && !client ? NO_YOUTUBE_KEY : [youtubeNote, client ? spotifyNote : null].filter(Boolean).join('. ') || null;
      await ctx.tx
        .update(streamTracks)
        .set({ status: pollable ? 'tracking' : 'pending_match', nextPollAt: pollable ? new Date() : null, lastResolvedAt: new Date(), lastError })
        .where(eq(streamTracks.id, info.st.id));
    });
    job.log.info({ trackId, spotify: client ? !spotifyNote : 'no key', candidates, picks: picks.map((p) => `${p.variant}:${p.confidence}`) }, 'track resolved');
  }),

  /** Poll every due track in one org: YouTube in batches of 50, Spotify play counts via SpotScraper, and the licensed provider when one is configured. */
  defineJob('streams.poll-org', async (job) => {
    const now = new Date();
    const due = await job.withOrg((ctx) =>
      ctx.tx
        .select({ id: streamTracks.id, trackId: streamTracks.trackId, isrc: streamTracks.isrc })
        .from(streamTracks)
        .where(and(eq(streamTracks.status, 'tracking'), or(isNull(streamTracks.nextPollAt), lte(streamTracks.nextPollAt, now))))
        .limit(5000),
    );
    if (due.length === 0) return;
    const trackIds = due.map((d) => d.trackId);
    const [videos, active] = await job.withOrg(async (ctx) => {
      await ensureDefaultRules(ctx);
      return [await confirmedVideos(ctx, trackIds), await activeTrackIds(ctx, trackIds)] as const;
    });
    const errors = new Map<string, string>();
    const snapshots: Snapshot[] = [];

    // YouTube: public view counts, through videos.list with a key, else through Apify once a day per track.
    const ytRefs: TrackRef[] = videos.map((v) => ({ trackId: v.trackId, platform: 'youtube', externalId: v.externalId }));
    if (ytRefs.length) {
      const reader = await youtubeReader(job);
      if (!reader) for (const r of ytRefs) errors.set(r.trackId, NO_YOUTUBE_KEY);
      else if ('key' in reader) {
        try {
          const res = await youtubeAdapter.fetch({ apiKey: reader.key }, ytRefs);
          snapshots.push(...res.snapshots);
          for (const m of res.missing) errors.set(m.trackId, `YouTube video ${m.externalId} is unavailable or hides its view count`);
        } catch (err) {
          if (err instanceof RateLimitedError || isTransient(err)) throw err; // retried or delayed by the worker
          for (const r of ytRefs) errors.set(r.trackId, `YouTube: ${(err as Error).message.slice(0, 200)}`);
        }
      } else {
        // Billed per video, so a track is read once per day: today's reading is enough for daily plays.
        const readToday = await job.withOrg((ctx) => youtubeScrapedToday(ctx, [...new Set(ytRefs.map((r) => r.trackId))]));
        const refs = ytRefs.filter((r) => !readToday.has(r.trackId));
        try {
          if (refs.length) {
            const res = await fetchViewsApify(reader.apify, refs);
            snapshots.push(...res.snapshots);
            for (const m of res.missing) errors.set(m.trackId, `YouTube video ${m.externalId} is unavailable or hides its view count`);
          }
        } catch (err) {
          // Never retried automatically: a retry would pay for the same videos again. The next daily read picks them up.
          job.log.warn({ err: (err as Error).message }, 'youtube via apify failed');
          for (const r of refs) errors.set(r.trackId, `YouTube (Apify): ${(err as Error).message.slice(0, 200)}`);
        } finally {
          await countApify(job, reader.apify);
        }
      }
    }

    // Spotify play counts (SpotScraper): one request per track. Failures never stop YouTube readings being recorded.
    const client = await job.withOrg((ctx) => spotScraperFor(ctx));
    if (client) {
      try {
        const refs = await matchSpotify(job, client, trackIds);
        if (refs.length) {
          const res = await spotifyAdapter.fetch(client, refs);
          snapshots.push(...res.snapshots);
          for (const m of res.missing) if (!errors.has(m.trackId)) errors.set(m.trackId, `Spotify track ${m.externalId} is unavailable or shows no play count`);
          // The reads name each track's Spotify artists: link roster artists who have no profile yet.
          if (res.artists?.length) {
            await job.withOrg((ctx) => linkSpotifyArtists(ctx, res.artists!)).catch((err: Error) => job.log.warn({ err: err.message }, 'linking spotify artists failed'));
          }
        }
      } catch (err) {
        const message = err instanceof RateLimitedError ? 'SpotScraper rate limit reached; Spotify plays resume at the next poll' : `Spotify: ${(err as Error).message.slice(0, 200)}`;
        job.log.warn({ err: (err as Error).message }, 'spotify polling failed');
        for (const id of trackIds) if (!errors.has(id)) errors.set(id, message);
      } finally {
        await countRequests(job, client);
      }
    } else {
      const orphaned = await job.withOrg((ctx) => spotifyPrimaries(ctx, trackIds));
      for (const o of orphaned) if (!errors.has(o.trackId) && !videos.some((v) => v.trackId === o.trackId)) errors.set(o.trackId, NO_SPOTSCRAPER_KEY);
    }

    // Licensed provider (DSP counts), matched by ISRC. Skipped until a vendor is chosen and installed.
    const licensed = await job.withOrg((ctx) => readSecret(ctx, 'licensed_streams'));
    const secret = licensed?.secret as LicensedStreamSecret | undefined;
    if (secret && licensedStreamProvider(secret.vendor)) {
      const refs = due.filter((d) => d.isrc).map((d) => ({ trackId: d.trackId, platform: 'licensed', externalId: d.isrc! }));
      try {
        snapshots.push(...(await licensedAdapter.fetch(secret, refs)).snapshots);
      } catch (err) {
        if (err instanceof RateLimitedError || isTransient(err)) throw err;
        job.log.warn({ err: (err as Error).message }, 'licensed provider failed');
      }
    }

    // Record in chunks so one transaction never grows huge.
    const recorded: Array<{ trackId: string; platform: string; source: Snapshot['source']; day: string; total: number; delta: number }> = [];
    for (let i = 0; i < snapshots.length; i += 400) {
      const part = snapshots.slice(i, i + 400);
      recorded.push(...(await job.withOrg((ctx) => recordSnapshots(ctx, part))));
    }
    await job.withOrg(async (ctx) => {
      for (const r of recorded) {
        await evaluateTrackAlerts(ctx, r.trackId, r.platform, r.source);
        if (r.delta !== 0) await ctx.emit('streams.snapshot.recorded', { trackId: r.trackId, platform: r.platform, source: r.source, count: r.total, capturedAt: now.toISOString() });
      }
      // Reschedule everything that was due, by tier. Tracks that failed for lack of a key wait 6 hours instead of every 15 minutes.
      for (const d of due) {
        const tier = active.has(d.trackId) ? 'active' : 'catalogue';
        const err = errors.get(d.trackId) ?? null;
        await ctx.tx
          .update(streamTracks)
          .set({ tier, lastPolledAt: now, nextPollAt: nextPollAt(err === NO_YOUTUBE_KEY ? 'active' : tier, now), lastError: err })
          .where(eq(streamTracks.id, d.id));
      }
    });
    const isrcs = new Map(due.map((d) => [d.trackId, d.isrc]));
    await sendWebhook(job, recorded.map((r) => ({ trackId: r.trackId, isrc: isrcs.get(r.trackId) ?? null, platform: r.platform, source: r.source, day: r.day, total: r.total, delta: r.delta })));
    job.log.info({ due: due.length, snapshots: snapshots.length, errors: errors.size }, 'streams polled');
  }),

  /** Exact counts from a parsed distributor statement (Documents), recomputed for the tracks it mentions. */
  defineJob('streams.import-statement', async (job, data) => {
    const result = await job.withOrg(async (ctx) => {
      const affected = await ctx.tx.selectDistinct({ trackId: statementLines.trackId }).from(statementLines).where(and(eq(statementLines.documentId, data.documentId), isNotNull(statementLines.trackId)));
      const ids = affected.map((a) => a.trackId!).filter(Boolean);
      if (ids.length === 0) return { tracks: 0, periods: 0, items: [] as unknown[] };
      const lines = await ctx.tx
        .select({ trackId: statementLines.trackId, source: statementLines.source, periodEnd: statementLines.periodEnd, units: statementLines.units })
        .from(statementLines)
        .innerJoin(documents, and(eq(documents.id, statementLines.documentId), eq(documents.isLatest, true), eq(documents.type, 'statement')))
        .where(inArray(statementLines.trackId, ids));
      const totals = statementPeriodTotals(lines);
      await rollupStatementCounts(ctx, totals);
      for (const id of ids) await registerTrack(ctx, id);
      const latest = new Map<string, (typeof totals)[number]>();
      for (const t of totals) if (!latest.has(`${t.trackId}|${t.platform}`) || latest.get(`${t.trackId}|${t.platform}`)!.periodEnd < t.periodEnd) latest.set(`${t.trackId}|${t.platform}`, t);
      for (const t of latest.values()) await ctx.emit('streams.snapshot.recorded', { trackId: t.trackId, platform: t.platform, source: 'statement-import', count: t.units, capturedAt: `${t.periodEnd}T23:59:59Z` });
      return { tracks: ids.length, periods: totals.length, items: totals.map((t) => ({ trackId: t.trackId, platform: t.platform, source: 'statement-import', day: t.periodEnd, total: t.units, delta: t.units })) };
    });
    await sendWebhook(job, result.items);
    job.log.info({ documentId: data.documentId, tracks: result.tracks, periods: result.periods }, 'statement counts imported');
  }),

  /**
   * Daily: each artist's Spotify audience (monthly listeners, followers, world
   * rank, top cities) and the playlists listeners discovered them on. Two
   * SpotScraper requests per artist with a Spotify artist ID.
   */
  defineJob('streams.audience', async (job, data) => {
    const day = new Date().toISOString().slice(0, 10);
    if (!job.orgId) {
      const rows = (await systemDb().execute(sql`
        select distinct a.org_id from artists a
        where a.spotify_artist_id is not null and a.spotify_artist_id <> ''
          and (${Boolean(env().SPOTSCRAPER_API_KEY)} or exists (select 1 from credentials c where c.org_id = a.org_id and c.provider = 'spotscraper' and c.revoked_at is null))
        limit 1000`)) as unknown as Array<{ org_id: string }>;
      let queued = 0;
      for (const r of rows) {
        if (!(await streamsEnabled(r.org_id))) continue;
        await enqueue('streams.audience', r.org_id, {}, { jobId: `audience-${r.org_id}-${day}`, attempts: 3, backoff: { type: 'exponential', delay: 300_000 } });
        queued++;
      }
      return { labels: queued };
    }
    const client = await job.withOrg((ctx) => spotScraperFor(ctx));
    if (!client) return { skipped: 'no SpotScraper key' };
    const only = data?.artistIds?.length ? data.artistIds : null;
    const roster = await job.withOrg((ctx) => ctx.tx.select({ id: artists.id, spotifyArtistId: artists.spotifyArtistId }).from(artists).where(only ? and(isNotNull(artists.spotifyArtistId), inArray(artists.id, only)) : isNotNull(artists.spotifyArtistId)));
    const rows: ArtistStatsInput[] = [];
    try {
      for (const a of roster) {
        const spotifyId = spotifyIdFrom(a.spotifyArtistId, 'artist');
        if (!spotifyId) continue;
        const stats = await client.artist(spotifyId);
        if (!stats) {
          job.log.warn({ artistId: a.id, spotifyId }, 'spotify artist not found');
          continue;
        }
        const discovered = await client.discoveredOn(spotifyId, 50).catch((err: Error) => {
          job.log.warn({ err: err.message, artistId: a.id }, 'discovered-on failed');
          return [];
        });
        rows.push({ artistId: a.id, spotifyArtistId: spotifyId, day, monthlyListeners: stats.monthlyListeners, followers: stats.followers, worldRank: stats.worldRank, topCities: stats.topCities, discoveredOn: discovered.map((p) => ({ id: p.id, name: p.name, owner: p.ownerName })) });
      }
    } finally {
      if (rows.length) await job.withOrg((ctx) => recordArtistStats(ctx, rows));
      await countRequests(job, client);
    }
    return { artists: rows.length };
  }),

  /**
   * Find Spotify profiles for artists without one, from the Spotify tracks
   * they are on: one request per track read, at most three per artist, and
   * usually one. Each artist linked has their audience read straight away.
   */
  defineJob('streams.link-artists', async (job, data) => {
    const client = await job.withOrg((ctx) => spotScraperFor(ctx));
    if (!client) return { skipped: 'no SpotScraper key' };
    const plan = await job.withOrg((ctx) => spotifyLinkPlan(ctx, data?.artistIds));
    const found: TrackArtistRefs[] = [];
    const read = new Map<string, Array<{ id: string; name: string }>>();
    try {
      for (const p of plan) {
        const keys = new Set(p.names.map(normName).filter(Boolean));
        for (const r of p.reads) {
          const key = r.spotifyId ?? `isrc:${r.isrc}`;
          if (!read.has(key)) {
            try {
              const t = r.spotifyId ? await client.track(r.spotifyId) : pickIsrcMatch(await client.searchIsrc(r.isrc!), r.isrc!, p.names);
              read.set(key, t?.artists ?? []);
            } catch (err) {
              if (err instanceof RateLimitedError) throw err;
              job.log.warn({ err: (err as Error).message, trackId: r.trackId }, 'spotify read for artist link failed');
              read.set(key, []);
            }
          }
          const artists = read.get(key)!;
          if (artists.length) found.push({ trackId: r.trackId, artists });
          if (artists.some((a) => keys.has(normName(a.name)))) break;
        }
      }
    } finally {
      await countRequests(job, client);
    }
    const linked = await job.withOrg((ctx) => linkSpotifyArtists(ctx, found));
    job.log.info({ artists: plan.length, linked: linked.length }, 'spotify artist profiles linked');
    return { looked: plan.length, linked: linked.length };
  }),

  /** Keep monthly partitions three months ahead so inserts never land in the default partition. */
  defineJob('streams.maintain-partitions', async () => {
    await systemDb().execute(sql`select ensure_stream_snapshot_partitions(3)`);
  }),
];
