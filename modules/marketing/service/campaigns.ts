import '../types';
import { and, desc, eq, inArray, isNull, lte, or, sql } from 'drizzle-orm';
import { z } from 'zod';
import { patchOf } from '@labelconsole/core/zod';
import type { ServiceContext } from '@labelconsole/core/context';
import { NotFoundError, ValidationError } from '@labelconsole/core/errors';
import { releaseTracks, releases, tracks } from '@labelconsole/catalogue/schema';
import { playsForTracks } from '@labelconsole/streams/service';
import { boards, CAMPAIGN_STATUSES, campaigns, cards, pitches, sketchboards, type Campaign, type Kpi } from '../schema';
import { addDays, cardCampaign, daysBetween, isBooking, today } from './shared';

export const KpiInput = z.object({
  name: z.string().trim().min(1).max(80),
  target: z.number().min(0),
  unit: z.string().trim().max(20).default(''),
  metric: z.enum(['streams', 'views', 'posts', 'adds', 'custom']).default('custom'),
  actual: z.number().min(0).nullable().optional(),
});

export const CampaignInput = z.object({
  name: z.string().trim().min(1).max(200),
  releaseId: z.uuid().nullable().optional(),
  goals: z.string().max(5000).nullable().optional(),
  budgetCents: z.number().int().min(0).default(0),
  currency: z.string().length(3).default('USD'),
  kpis: z.array(KpiInput).max(12).default([]),
  startDate: z.iso.date().nullable().optional(),
  endDate: z.iso.date().nullable().optional(),
  status: z.enum(CAMPAIGN_STATUSES).default('planning'),
  ownerId: z.uuid().nullable().optional(),
});
export const CampaignPatch = patchOf(CampaignInput);

function checkDates(d: { startDate?: string | null; endDate?: string | null }) {
  if (d.startDate && d.endDate && d.endDate < d.startDate) throw new ValidationError('The campaign ends before it starts', { fieldErrors: { endDate: ['Must be on or after the start date'] } });
}

export async function createCampaign(ctx: ServiceContext, input: z.input<typeof CampaignInput>) {
  ctx.assert('marketing:write');
  const data = CampaignInput.parse(input);
  checkDates(data);
  if (data.releaseId) await assertRelease(ctx, data.releaseId);
  const [row] = await ctx.tx.insert(campaigns).values({ ...data, kpis: data.kpis as Kpi[] }).returning();
  // Every campaign gets a creator board, so bookings have somewhere to go.
  await ctx.tx.insert(boards).values({ name: `${row.name} · creators`, kind: 'creator', campaignId: row.id });
  await ctx.audit({ action: 'campaign.created', module: 'marketing', targetType: 'campaign', targetId: row.id, targetLabel: row.name, after: data });
  await ctx.emit('marketing.campaign.created', { campaignId: row.id, name: row.name, releaseId: row.releaseId });
  if (row.status === 'active') await ctx.emit('marketing.campaign.started', { campaignId: row.id, name: row.name, releaseId: row.releaseId });
  return row;
}

async function assertRelease(ctx: ServiceContext, id: string) {
  const [r] = await ctx.tx.select({ id: releases.id }).from(releases).where(eq(releases.id, id));
  if (!r) throw new ValidationError('That release does not exist', { fieldErrors: { releaseId: ['Unknown release'] } });
}

export async function updateCampaign(ctx: ServiceContext, id: string, patch: z.input<typeof CampaignPatch>) {
  ctx.assert('marketing:write');
  const before = await getCampaignRow(ctx, id);
  const data = CampaignPatch.parse(patch);
  checkDates({ startDate: data.startDate !== undefined ? data.startDate : before.startDate, endDate: data.endDate !== undefined ? data.endDate : before.endDate });
  if (data.releaseId) await assertRelease(ctx, data.releaseId);
  const [after] = await ctx.tx.update(campaigns).set({ ...data, kpis: data.kpis as Kpi[] | undefined }).where(eq(campaigns.id, id)).returning();
  await ctx.audit({ action: data.status && data.status !== before.status ? 'campaign.status_changed' : 'campaign.updated', module: 'marketing', targetType: 'campaign', targetId: id, targetLabel: after.name, before: before as never, after: after as never });
  if (data.status === 'active' && before.status !== 'active') await ctx.emit('marketing.campaign.started', { campaignId: id, name: after.name, releaseId: after.releaseId });
  return after;
}

export async function deleteCampaign(ctx: ServiceContext, id: string) {
  ctx.assert('marketing:delete');
  const c = await getCampaignRow(ctx, id);
  // Its boards (and their cards) go with it, so paid bookings anywhere on the campaign block the delete.
  const [paid] = await ctx.tx.select({ n: sql<number>`count(*)::int` }).from(cards).innerJoin(boards, eq(boards.id, cards.boardId)).where(and(eq(cardCampaign, id), sql`coalesce(${cards.paidCents}, 0) > 0`));
  if ((paid?.n ?? 0) > 0) throw new ValidationError('This campaign has paid bookings. Cancel it instead, so the spend stays on record.');
  await ctx.tx.delete(campaigns).where(eq(campaigns.id, id));
  await ctx.audit({ action: 'campaign.deleted', module: 'marketing', targetType: 'campaign', targetId: id, targetLabel: c.name });
}

export async function getCampaignRow(ctx: ServiceContext, id: string) {
  ctx.assert('marketing:read');
  const [row] = await ctx.tx.select().from(campaigns).where(eq(campaigns.id, id));
  if (!row) throw new NotFoundError('Campaign');
  return row;
}

/** Spend, delivery and reach per campaign, from its bookings and pitches. */
export async function campaignStats(ctx: ServiceContext, ids: string[]) {
  if (ids.length === 0) return new Map<string, CampaignStats>();
  const [booked, pitched] = await Promise.all([
    ctx.tx
      .select({
        campaignId: cardCampaign,
        bookings: sql<number>`count(*) filter (where ${isBooking})::int`,
        paidCents: sql<number>`coalesce(sum(${cards.paidCents}), 0)::bigint`,
        offerCents: sql<number>`coalesce(sum(${cards.offerCents}) filter (where ${isBooking}), 0)::bigint`,
        ordered: sql<number>`coalesce(sum(${cards.deliverablesOrdered}) filter (where ${isBooking}), 0)::int`,
        delivered: sql<number>`coalesce(sum(${cards.deliverablesDelivered}) filter (where ${isBooking}), 0)::int`,
        views: sql<number>`coalesce(sum(${cards.measuredViews}), 0)::bigint`,
        measured: sql<number>`count(*) filter (where ${cards.measuredViews} is not null)::int`,
        unproven: sql<number>`count(*) filter (where coalesce(${cards.paidCents}, 0) > 0 and cardinality(${cards.proofUrls}) = 0)::int`,
        cards: sql<number>`count(*)::int`,
      })
      .from(cards)
      .innerJoin(boards, eq(boards.id, cards.boardId))
      .where(inArray(cardCampaign, ids))
      .groupBy(cardCampaign),
    ctx.tx
      .select({ campaignId: pitches.campaignId, total: sql<number>`count(*)::int`, sent: sql<number>`count(*) filter (where ${pitches.sentAt} is not null)::int`, accepted: sql<number>`count(*) filter (where ${pitches.status} = 'accepted')::int` })
      .from(pitches)
      .where(inArray(pitches.campaignId, ids))
      .groupBy(pitches.campaignId),
  ]);
  const out = new Map<string, CampaignStats>();
  for (const id of ids) {
    const b = booked.find((r) => r.campaignId === id);
    const p = pitched.find((r) => r.campaignId === id);
    const paid = Number(b?.paidCents ?? 0);
    const views = Number(b?.views ?? 0);
    out.set(id, {
      bookings: b?.bookings ?? 0,
      cards: b?.cards ?? 0,
      paidCents: paid,
      offerCents: Number(b?.offerCents ?? 0),
      ordered: b?.ordered ?? 0,
      delivered: b?.delivered ?? 0,
      views,
      measured: b?.measured ?? 0,
      unproven: b?.unproven ?? 0,
      costPer1kCents: views > 0 ? Math.round((paid / views) * 1000) : null,
      pitches: p?.total ?? 0,
      pitchesSent: p?.sent ?? 0,
      accepted: p?.accepted ?? 0,
    });
  }
  return out;
}
export type CampaignStats = { bookings: number; cards: number; paidCents: number; offerCents: number; ordered: number; delivered: number; views: number; measured: number; unproven: number; costPer1kCents: number | null; pitches: number; pitchesSent: number; accepted: number };

export const CampaignQuery = z.object({ status: z.enum(CAMPAIGN_STATUSES).optional(), q: z.string().trim().max(100).optional(), releaseId: z.uuid().optional() });

export async function listCampaigns(ctx: ServiceContext, q: Partial<z.infer<typeof CampaignQuery>> = {}) {
  ctx.assert('marketing:read');
  const conds = [];
  if (q.status) conds.push(eq(campaigns.status, q.status));
  if (q.releaseId) conds.push(eq(campaigns.releaseId, q.releaseId));
  if (q.q) conds.push(sql`${campaigns.name} ilike ${`%${q.q}%`}`);
  const rows = await ctx.tx
    .select({ campaign: campaigns, releaseTitle: releases.title, releaseDate: releases.releaseDate })
    .from(campaigns)
    .leftJoin(releases, eq(releases.id, campaigns.releaseId))
    .where(conds.length ? and(...conds) : undefined)
    .orderBy(sql`case ${campaigns.status} when 'active' then 0 when 'planning' then 1 when 'paused' then 2 else 3 end`, desc(campaigns.startDate), desc(campaigns.createdAt))
    .limit(500);
  const stats = await campaignStats(ctx, rows.map((r) => r.campaign.id));
  return rows.map((r) => ({ ...r.campaign, releaseTitle: r.releaseTitle, releaseDate: r.releaseDate, stats: stats.get(r.campaign.id)! }));
}

/**
 * Stream delta: plays on the release's tracks during the campaign versus the
 * same number of days just before it started.
 */
export async function streamDelta(ctx: ServiceContext, c: Pick<Campaign, 'releaseId' | 'startDate' | 'endDate'>) {
  if (!c.releaseId || !c.startDate) return null;
  const trackIds = (await ctx.tx.select({ id: releaseTracks.trackId }).from(releaseTracks).where(eq(releaseTracks.releaseId, c.releaseId))).map((t) => t.id);
  if (trackIds.length === 0) return null;
  const end = c.endDate && c.endDate < today() ? c.endDate : today();
  if (c.startDate > end) return { trackCount: trackIds.length, days: 0, during: 0, before: 0, change: 0, changePct: null, daily: [] as Array<{ day: string; plays: number }>, from: c.startDate, to: end };
  const days = daysBetween(c.startDate, end) + 1;
  const [during, before, chart] = await Promise.all([
    playsForTracks(ctx, trackIds, c.startDate, end),
    playsForTracks(ctx, trackIds, addDays(c.startDate, -days), addDays(c.startDate, -1)),
    playsForTracks(ctx, trackIds, addDays(c.startDate, -Math.min(days, 60)), end),
  ]);
  return { trackCount: trackIds.length, days, during: during.total, before: before.total, change: during.total - before.total, changePct: before.total > 0 ? ((during.total - before.total) / before.total) * 100 : null, daily: chart.daily, from: c.startDate, to: end };
}

export type KpiResult = Kpi & { measured: number | null; progress: number | null };

function kpiActuals(kpis: Kpi[], stats: CampaignStats, delta: Awaited<ReturnType<typeof streamDelta>>): KpiResult[] {
  return kpis.map((k) => {
    const measured = k.metric === 'streams' ? (delta?.during ?? null) : k.metric === 'views' ? stats.views : k.metric === 'posts' ? stats.delivered : k.metric === 'adds' ? stats.accepted : (k.actual ?? null);
    return { ...k, measured, progress: measured != null && k.target > 0 ? Math.min(100, (measured / k.target) * 100) : null };
  });
}

export async function getCampaign(ctx: ServiceContext, id: string) {
  const c = await getCampaignRow(ctx, id);
  const [release, releaseTrackRows, boardRows, pitchRows, sketchRows, stats, delta] = await Promise.all([
    c.releaseId ? ctx.tx.select().from(releases).where(eq(releases.id, c.releaseId)).then((r) => r[0] ?? null) : null,
    c.releaseId ? ctx.tx.select({ id: tracks.id, title: tracks.title }).from(releaseTracks).innerJoin(tracks, eq(tracks.id, releaseTracks.trackId)).where(eq(releaseTracks.releaseId, c.releaseId)) : [],
    ctx.tx.select().from(boards).where(eq(boards.campaignId, id)).orderBy(boards.createdAt),
    ctx.tx.select().from(pitches).where(eq(pitches.campaignId, id)).orderBy(desc(pitches.updatedAt)).limit(200),
    ctx.tx.select({ id: sketchboards.id, name: sketchboards.name, updatedAt: sketchboards.updatedAt }).from(sketchboards).where(eq(sketchboards.campaignId, id)),
    campaignStats(ctx, [id]).then((m) => m.get(id)!),
    streamDelta(ctx, c),
  ]);
  const cardRows = await ctx.tx.select({ card: cards, boardName: boards.name, boardKind: boards.kind }).from(cards).innerJoin(boards, eq(boards.id, cards.boardId)).where(eq(cardCampaign, id)).orderBy(desc(cards.updatedAt)).limit(500);
  return { campaign: c, release, tracks: releaseTrackRows, boards: boardRows, cards: cardRows, pitches: pitchRows, sketchboards: sketchRows, stats, streamDelta: delta, kpis: kpiActuals(c.kpis, stats, delta) };
}

/** Tracks of releases in live campaigns poll every 6 hours (Streams asks through the `stream-tier` enrich hook). */
export async function activeCampaignTrackIds(ctx: ServiceContext, trackIds: string[]) {
  if (trackIds.length === 0) return new Set<string>();
  const rows = await ctx.tx
    .selectDistinct({ trackId: releaseTracks.trackId })
    .from(campaigns)
    .innerJoin(releaseTracks, eq(releaseTracks.releaseId, campaigns.releaseId))
    .where(and(eq(campaigns.status, 'active'), inArray(releaseTracks.trackId, trackIds), or(isNull(campaigns.endDate), sql`${campaigns.endDate} >= ${today()}`), or(isNull(campaigns.startDate), lte(campaigns.startDate, addDays(today(), 7)))));
  return new Set(rows.map((r) => r.trackId));
}
