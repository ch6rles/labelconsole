import '../types';
import { createHmac } from 'node:crypto';
import { and, eq, inArray, isNotNull, isNull, lte, or, sql } from 'drizzle-orm';
import { withSystemOrg } from '@labelconsole/core/context';
import { systemDb } from '@labelconsole/core/db/client';
import { organizations } from '@labelconsole/core/db/schema';
import { env } from '@labelconsole/core/env';
import { isTransient, RateLimitedError } from '@labelconsole/core/errors';
import { enabledModuleIds } from '@labelconsole/core/modules';
import { defineJob, enqueue, type JobContext } from '@labelconsole/core/queue';
import { readSecret } from '@labelconsole/core/vault';
import { trackArtists, tracks } from '@labelconsole/catalogue/schema';
import { upsertIdentity } from '@labelconsole/catalogue/service';
import { documents, statementLines } from '@labelconsole/documents/schema';
import { artists } from '@labelconsole/people/schema';
import { streamTracks } from '../schema';
import { licensedAdapter, licensedStreamProvider, type LicensedStreamSecret } from '../sources/licensed';
import { statementPeriodTotals } from '../sources/statements';
import type { Snapshot, TrackRef } from '../sources/types';
import { AUTO_CONFIRM, REVIEW, scoreCandidates, searchVideos, youtubeAdapter } from '../sources/youtube';
import { activeTrackIds, backfillRegistry, confirmedVideos, ensureDefaultRules, evaluateTrackAlerts, nextPollAt, recordSnapshots, registerTrack, rollupStatementCounts } from '../service';

export const NO_YOUTUBE_KEY = 'Add a YouTube Data API key under Settings → Integrations to track YouTube views';
const POLL_SLOT_MS = 15 * 60_000;

async function youtubeKey(job: JobContext) {
  const s = await job.withOrg((ctx) => readSecret(ctx, 'youtube'));
  return s?.secret.apiKey || env().YOUTUBE_API_KEY || null;
}

async function streamsEnabled(orgId: string) {
  const [org] = await systemDb().select({ id: organizations.id, plan: organizations.plan }).from(organizations).where(eq(organizations.id, orgId));
  return org ? (await enabledModuleIds(systemDb(), org)).has('streams') : false;
}

/** Labels configure the URL, so refuse anything that could reach the platform's own network. */
export function isPublicHttps(raw: string) {
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    return false;
  }
  if (u.protocol !== 'https:') return false;
  const h = u.hostname.toLowerCase().replace(/^\[|\]$/g, '');
  if (h === 'localhost' || h.endsWith('.localhost') || h.endsWith('.internal') || h.endsWith('.local')) return false;
  if (/^(0|10|127)\./.test(h) || /^169\.254\./.test(h) || /^192\.168\./.test(h) || /^172\.(1[6-9]|2\d|3[01])\./.test(h) || /^100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\./.test(h)) return false;
  if (h === '::1' || h.startsWith('fc') || h.startsWith('fd') || h.startsWith('fe80') || h.startsWith('::ffff:')) return false;
  return true;
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
               or last_resolved_at < now() - case when last_error = ${NO_YOUTUBE_KEY} then interval '1 day' else interval '7 days' end)
      ) t where rn <= 5`)) as unknown as Array<{ id: string; org_id: string }>;
    for (const s of stale) {
      if (!(await streamsEnabled(s.org_id))) continue;
      await enqueue('streams.resolve-track', s.org_id, { streamTrackId: s.id }, { jobId: `resolve-${s.id}-${Math.floor(now.getTime() / 86400_000)}`, attempts: 2 });
    }
    job.log.info({ orgs: queued, resolves: stale.length }, 'streams scheduled');
  }),

  /** Map a track to its YouTube videos: one search, scored; low confidence goes to review. */
  defineJob('streams.resolve-track', async (job, data) => {
    const info = await job.withOrg(async (ctx) => {
      const [row] = await ctx.tx.select({ st: streamTracks, title: tracks.title, durationMs: tracks.durationMs }).from(streamTracks).innerJoin(tracks, eq(tracks.id, streamTracks.trackId)).where(eq(streamTracks.id, data.streamTrackId));
      if (!row) return null;
      const names = await ctx.tx.select({ name: artists.name }).from(trackArtists).innerJoin(artists, eq(artists.id, trackArtists.artistId)).where(and(eq(trackArtists.trackId, row.st.trackId), eq(trackArtists.role, 'primary')));
      return { ...row, artists: names.map((n) => n.name), videos: await confirmedVideos(ctx, [row.st.trackId]) };
    });
    if (!info || info.st.status === 'paused') return;
    if (info.videos.length) {
      await job.withOrg((ctx) => ctx.tx.update(streamTracks).set({ status: 'tracking', lastResolvedAt: new Date(), lastError: null, nextPollAt: new Date() }).where(eq(streamTracks.id, info.st.id)));
      return;
    }
    const key = await youtubeKey(job);
    if (!key) {
      await job.withOrg((ctx) => ctx.tx.update(streamTracks).set({ lastResolvedAt: new Date(), lastError: NO_YOUTUBE_KEY }).where(eq(streamTracks.id, info.st.id)));
      return;
    }
    const candidates = await searchVideos(key, `${info.artists[0] ?? ''} ${info.title}`.trim());
    const verdicts = scoreCandidates({ title: info.title, artists: info.artists, durationMs: info.durationMs }, candidates);
    const picks = [verdicts.find((v) => v.variant === 'topic'), verdicts.find((v) => v.variant === 'official')].filter((v): v is NonNullable<typeof v> => Boolean(v && v.confidence >= REVIEW));
    await job.withOrg(async (ctx) => {
      for (const v of picks) {
        await upsertIdentity(ctx, { entityType: 'track', entityId: info.st.trackId, platform: 'youtube', externalId: v.videoId, url: `https://www.youtube.com/watch?v=${v.videoId}`, source: 'youtube-search', confidence: v.confidence, status: v.confidence >= AUTO_CONFIRM ? 'confirmed' : 'pending_review', variant: v.variant });
      }
      const confirmed = (await confirmedVideos(ctx, [info.st.trackId])).length > 0;
      await ctx.tx
        .update(streamTracks)
        .set({ status: confirmed ? 'tracking' : 'pending_match', nextPollAt: confirmed ? new Date() : null, lastResolvedAt: new Date(), lastError: picks.length ? null : candidates.length ? 'No confident YouTube match; paste the video link on the Matching page' : 'No YouTube video found for this track' })
        .where(eq(streamTracks.id, info.st.id));
    });
    job.log.info({ trackId: info.st.trackId, candidates: candidates.length, picks: picks.map((p) => `${p.variant}:${p.confidence}`) }, 'youtube resolved');
  }),

  /** Poll every due track in one org: YouTube in batches of 50, plus the licensed provider when one is configured. */
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

    // YouTube: official view counts, videos.list only.
    const ytRefs: TrackRef[] = videos.map((v) => ({ trackId: v.trackId, platform: 'youtube', externalId: v.externalId }));
    if (ytRefs.length) {
      const key = await youtubeKey(job);
      if (!key) for (const r of ytRefs) errors.set(r.trackId, NO_YOUTUBE_KEY);
      else {
        try {
          const res = await youtubeAdapter.fetch({ apiKey: key }, ytRefs);
          snapshots.push(...res.snapshots);
          for (const m of res.missing) errors.set(m.trackId, `YouTube video ${m.externalId} is unavailable or hides its view count`);
        } catch (err) {
          if (err instanceof RateLimitedError || isTransient(err)) throw err; // retried or delayed by the worker
          for (const r of ytRefs) errors.set(r.trackId, `YouTube: ${(err as Error).message.slice(0, 200)}`);
        }
      }
    }

    // Licensed provider (Spotify and other DSP counts), matched by ISRC. Skipped until a vendor is chosen and installed.
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

  /** Keep monthly partitions three months ahead so inserts never land in the default partition. */
  defineJob('streams.maintain-partitions', async () => {
    await systemDb().execute(sql`select ensure_stream_snapshot_partitions(3)`);
  }),
];
