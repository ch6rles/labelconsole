import { and, asc, desc, eq, ilike, inArray, or, sql } from 'drizzle-orm';
import { z } from 'zod';
import { patchOf } from '@labelconsole/core/zod';
import type { ServiceContext } from '@labelconsole/core/context';
import { NotFoundError, ValidationError } from '@labelconsole/core/errors';
import { enqueueAfterCommit } from '@labelconsole/core/queue';
import { spotScraperConfigured } from '@labelconsole/core/spotscraper';
import { artists } from '@labelconsole/people/schema';
import { credits, platformIdentities, releaseTracks, releases, splitParties, splitSheets, trackArtists, tracks, type Track } from '../schema';
import { isrcField } from './shared';
import { linkTrack } from './releases';

export const TrackInput = z.object({
  title: z.string().trim().min(1).max(300),
  isrc: isrcField.optional(),
  durationMs: z.number().int().min(0).max(4 * 3600_000).nullable().optional(),
  version: z.string().trim().max(120).nullable().optional(),
  explicit: z.boolean().default(false),
  genre: z.string().trim().max(80).nullable().optional(),
  bpm: z.number().int().min(20).max(400).nullable().optional(),
  musicalKey: z.string().trim().max(12).nullable().optional(),
  language: z.string().trim().max(8).nullable().optional(),
  artistIds: z.array(z.uuid()).max(20).optional(),
  releaseId: z.uuid().optional(),
});
export const TrackPatch = patchOf(TrackInput.omit({ releaseId: true })).extend({ audioFileId: z.uuid().nullable().optional() });

export const CreditInput = z.object({ name: z.string().trim().min(1).max(200), role: z.string().trim().min(1).max(80), artistId: z.uuid().nullable().optional() });

export const SplitSheetInput = z.object({
  kind: z.enum(['master', 'publishing']).default('master'),
  parties: z
    .array(z.object({ name: z.string().trim().min(1).max(200), email: z.email().nullable().optional(), artistId: z.uuid().nullable().optional(), sharePct: z.number().gt(0).max(100) }))
    .min(1)
    .max(30),
  send: z.boolean().default(false),
});

/** What still blocks delivery of a track. Recomputed whenever any input changes. */
export async function recomputeBlockers(ctx: ServiceContext, trackId: string) {
  const [t] = await ctx.tx.select().from(tracks).where(eq(tracks.id, trackId));
  if (!t) return [];
  const [{ n: creditCount }] = await ctx.tx.select({ n: sql<number>`count(*)::int` }).from(credits).where(eq(credits.trackId, trackId));
  const sheets = await ctx.tx.select().from(splitSheets).where(and(eq(splitSheets.trackId, trackId), eq(splitSheets.kind, 'master')));
  const blockers: string[] = [];
  if (!t.isrc) blockers.push('No ISRC');
  if (!t.audioFileId) blockers.push('No audio');
  if (creditCount === 0) blockers.push('No credits');
  if (sheets.length === 0) blockers.push('No split sheet');
  else {
    const parties = await ctx.tx.select().from(splitParties).where(eq(splitParties.sheetId, sheets[0].id));
    const total = parties.reduce((n, p) => n + Number(p.sharePct), 0);
    if (Math.abs(total - 100) > 0.01) blockers.push('Splits do not add up to 100%');
    else if (sheets[0].status !== 'signed') blockers.push('Splits not signed');
  }
  const status = blockers.length ? 'draft' : 'ready';
  await ctx.tx.update(tracks).set({ blockers, status }).where(eq(tracks.id, trackId));
  return blockers;
}

export const ListTracksQuery = z.object({ q: z.string().trim().max(100).optional(), releaseId: z.uuid().optional(), status: z.enum(['draft', 'ready']).optional(), artistId: z.uuid().optional() });

export async function listTracks(ctx: ServiceContext, q: z.infer<typeof ListTracksQuery> = {}) {
  ctx.assert('catalogue:read');
  const conds = [];
  if (q.q) conds.push(or(ilike(tracks.title, `%${q.q}%`), ilike(tracks.isrc, `%${q.q.replace(/[^A-Za-z0-9]/g, '')}%`)));
  if (q.status) conds.push(eq(tracks.status, q.status));
  if (q.releaseId) conds.push(inArray(tracks.id, ctx.tx.select({ id: releaseTracks.trackId }).from(releaseTracks).where(eq(releaseTracks.releaseId, q.releaseId))));
  if (q.artistId) conds.push(inArray(tracks.id, ctx.tx.select({ id: trackArtists.trackId }).from(trackArtists).where(eq(trackArtists.artistId, q.artistId))));
  if (ctx.artistScope) conds.push(inArray(tracks.id, ctx.tx.select({ id: trackArtists.trackId }).from(trackArtists).where(inArray(trackArtists.artistId, [...ctx.artistScope]))));
  const rows = await ctx.tx.select().from(tracks).where(conds.length ? and(...conds) : undefined).orderBy(desc(tracks.createdAt)).limit(2000);
  if (rows.length === 0) return [];
  const ids = rows.map((r) => r.id);
  const [rel, art] = await Promise.all([
    ctx.tx.select({ trackId: releaseTracks.trackId, id: releases.id, title: releases.title, releaseDate: releases.releaseDate }).from(releaseTracks).innerJoin(releases, eq(releases.id, releaseTracks.releaseId)).where(inArray(releaseTracks.trackId, ids)),
    ctx.tx.select({ trackId: trackArtists.trackId, id: artists.id, name: artists.name }).from(trackArtists).innerJoin(artists, eq(artists.id, trackArtists.artistId)).where(inArray(trackArtists.trackId, ids)),
  ]);
  return rows.map((t) => ({ ...t, releases: rel.filter((r) => r.trackId === t.id).map(({ trackId: _, ...r }) => r), artists: art.filter((a) => a.trackId === t.id).map(({ trackId: _, ...a }) => a) }));
}

export async function getTrackRow(ctx: ServiceContext, id: string): Promise<Track> {
  ctx.assert('catalogue:read');
  const [t] = await ctx.tx.select().from(tracks).where(eq(tracks.id, id));
  if (!t) throw new NotFoundError('Track');
  return t;
}

export async function getTracksByIds(ctx: ServiceContext, ids: string[]) {
  if (ids.length === 0) return [];
  return ctx.tx.select().from(tracks).where(inArray(tracks.id, ids));
}

export async function getTrack(ctx: ServiceContext, id: string) {
  const track = await getTrackRow(ctx, id);
  const [rel, art, creditRows, sheets, identities] = await Promise.all([
    ctx.tx.select({ id: releases.id, title: releases.title, type: releases.type, releaseDate: releases.releaseDate, upc: releases.upc, position: releaseTracks.position }).from(releaseTracks).innerJoin(releases, eq(releases.id, releaseTracks.releaseId)).where(eq(releaseTracks.trackId, id)),
    ctx.tx.select({ id: artists.id, name: artists.name, role: trackArtists.role }).from(trackArtists).innerJoin(artists, eq(artists.id, trackArtists.artistId)).where(eq(trackArtists.trackId, id)),
    ctx.tx.select().from(credits).where(eq(credits.trackId, id)).orderBy(asc(credits.role), asc(credits.name)),
    ctx.tx.select().from(splitSheets).where(eq(splitSheets.trackId, id)),
    ctx.tx.select().from(platformIdentities).where(and(eq(platformIdentities.entityType, 'track'), eq(platformIdentities.entityId, id))),
  ]);
  const parties = sheets.length ? await ctx.tx.select().from(splitParties).where(inArray(splitParties.sheetId, sheets.map((s) => s.id))).orderBy(desc(splitParties.sharePct)) : [];
  return { track, releases: rel, artists: art, credits: creditRows, splitSheets: sheets.map((s) => ({ ...s, parties: parties.filter((p) => p.sheetId === s.id) })), identities };
}

async function setTrackArtists(ctx: ServiceContext, trackId: string, artistIds: string[]) {
  await ctx.tx.delete(trackArtists).where(eq(trackArtists.trackId, trackId));
  if (artistIds.length) await ctx.tx.insert(trackArtists).values(artistIds.map((artistId, i) => ({ trackId, artistId, role: i === 0 ? 'primary' : 'featured' })));
}

export async function createTrack(ctx: ServiceContext, input: z.input<typeof TrackInput>) {
  ctx.assert('catalogue:write');
  const { artistIds, releaseId, ...data } = TrackInput.parse(input);
  if (data.isrc) {
    const [dupe] = await ctx.tx.select({ id: tracks.id, title: tracks.title }).from(tracks).where(eq(tracks.isrc, data.isrc));
    if (dupe) throw new ValidationError(`ISRC ${data.isrc} is already used by "${dupe.title}"`, { fieldErrors: { isrc: ['Already in the catalogue'] } });
  }
  const [row] = await ctx.tx.insert(tracks).values({ ...data, isrc: data.isrc ?? null }).returning();
  if (artistIds?.length) await setTrackArtists(ctx, row.id, artistIds);
  if (releaseId) await linkTrack(ctx, releaseId, row.id);
  const blockers = await recomputeBlockers(ctx, row.id);
  await ctx.audit({ action: 'track.created', module: 'catalogue', targetType: 'track', targetId: row.id, targetLabel: row.title, after: { title: row.title, isrc: row.isrc } });
  await ctx.emit('catalogue.track.created', { trackId: row.id, title: row.title, isrc: row.isrc });
  return { ...row, blockers };
}

export async function updateTrack(ctx: ServiceContext, id: string, patch: z.input<typeof TrackPatch>) {
  ctx.assert('catalogue:write');
  const before = await getTrackRow(ctx, id);
  const { artistIds, ...data } = TrackPatch.parse(patch);
  if (data.isrc && data.isrc !== before.isrc) {
    const [dupe] = await ctx.tx.select({ id: tracks.id, title: tracks.title }).from(tracks).where(eq(tracks.isrc, data.isrc));
    if (dupe) throw new ValidationError(`ISRC ${data.isrc} is already used by "${dupe.title}"`, { fieldErrors: { isrc: ['Already in the catalogue'] } });
  }
  if (Object.keys(data).length) await ctx.tx.update(tracks).set(data).where(eq(tracks.id, id));
  if (artistIds) await setTrackArtists(ctx, id, artistIds);
  await recomputeBlockers(ctx, id);
  const after = await getTrackRow(ctx, id);
  await ctx.audit({ action: 'track.updated', module: 'catalogue', targetType: 'track', targetId: id, targetLabel: after.title, before: before as never, after: after as never });
  return after;
}

export async function deleteTrack(ctx: ServiceContext, id: string) {
  ctx.assert('catalogue:delete');
  const before = await getTrackRow(ctx, id);
  await ctx.tx.delete(tracks).where(eq(tracks.id, id));
  await ctx.tx.delete(platformIdentities).where(and(eq(platformIdentities.entityType, 'track'), eq(platformIdentities.entityId, id)));
  await ctx.audit({ action: 'track.deleted', module: 'catalogue', targetType: 'track', targetId: id, targetLabel: before.title, before: { title: before.title, isrc: before.isrc } });
}

export async function findTrackByIsrc(ctx: ServiceContext, isrc: string) {
  const [t] = await ctx.tx.select().from(tracks).where(eq(tracks.isrc, isrc));
  return t ?? null;
}

/* ------------------------------------------------------------ credits -- */

export async function addCredit(ctx: ServiceContext, trackId: string, input: z.infer<typeof CreditInput>) {
  ctx.assert('catalogue:write');
  const t = await getTrackRow(ctx, trackId);
  const [row] = await ctx.tx.insert(credits).values({ trackId, ...input }).returning();
  await recomputeBlockers(ctx, trackId);
  await ctx.audit({ action: 'credit.added', module: 'catalogue', targetType: 'track', targetId: trackId, targetLabel: t.title, after: { name: row.name, role: row.role } });
  return row;
}

export async function removeCredit(ctx: ServiceContext, creditId: string) {
  ctx.assert('catalogue:write');
  const [row] = await ctx.tx.delete(credits).where(eq(credits.id, creditId)).returning();
  if (!row) throw new NotFoundError('Credit');
  await recomputeBlockers(ctx, row.trackId);
  await ctx.audit({ action: 'credit.removed', module: 'catalogue', targetType: 'track', targetId: row.trackId, before: { name: row.name, role: row.role } });
}

/**
 * Queue a credits import from Spotify (SpotScraper) for some tracks, or for
 * every track that has no credits yet. Runs in the worker: the key may be in
 * the vault, and requests never run inside a transaction.
 */
export async function requestCreditImport(ctx: ServiceContext, trackIds?: string[]) {
  ctx.assert('catalogue:write');
  if (!(await spotScraperConfigured(ctx))) throw new ValidationError('Importing credits from Spotify needs a SpotScraper key under Settings → Integrations');
  if (trackIds?.length) for (const id of trackIds) await getTrackRow(ctx, id);
  enqueueAfterCommit(ctx, 'catalogue.import-credits', { trackIds: trackIds ?? null }, { jobId: `credits-${ctx.orgId}-${trackIds?.length === 1 ? trackIds[0] : 'missing'}-${Math.floor(Date.now() / 60_000)}`, attempts: 3, backoff: { type: 'exponential', delay: 30_000 } });
  return { queued: true };
}

/** Tracks with no credits yet, for a bulk import. */
export async function tracksWithoutCredits(ctx: ServiceContext, limit = 200) {
  return ctx.tx
    .select({ id: tracks.id })
    .from(tracks)
    .where(sql`not exists (select 1 from credits c where c.track_id = ${tracks.id})`)
    .orderBy(desc(tracks.createdAt))
    .limit(limit);
}

/**
 * Add credits read from Spotify that the track doesn't list yet (same name and
 * role, ignoring case), linking roster artists by name or alias.
 */
export async function addImportedCredits(ctx: ServiceContext, trackId: string, imported: Array<{ name: string; role: string }>) {
  const t = await getTrackRow(ctx, trackId);
  const key = (name: string, role: string) => `${name.trim().toLowerCase()}|${role.trim().toLowerCase()}`;
  const seen = new Set((await ctx.tx.select({ name: credits.name, role: credits.role }).from(credits).where(eq(credits.trackId, trackId))).map((c) => key(c.name, c.role)));
  const roster = await ctx.tx.select({ id: artists.id, name: artists.name, aliases: artists.aliases }).from(artists);
  const artistFor = (name: string) => roster.find((a) => [a.name, ...a.aliases].some((n) => n.trim().toLowerCase() === name.trim().toLowerCase()))?.id ?? null;
  const added: Array<{ name: string; role: string }> = [];
  for (const c of imported) {
    const name = c.name.trim().slice(0, 200);
    const role = c.role.trim().slice(0, 80);
    if (!name || !role || seen.has(key(name, role))) continue;
    seen.add(key(name, role));
    await ctx.tx.insert(credits).values({ trackId, name, role, artistId: artistFor(name) });
    added.push({ name, role });
  }
  if (added.length) {
    await recomputeBlockers(ctx, trackId);
    await ctx.audit({ action: 'credits.imported', module: 'catalogue', targetType: 'track', targetId: trackId, targetLabel: t.title, after: { source: 'spotify', added } });
  }
  return { added: added.length, skipped: imported.length - added.length };
}

/* ------------------------------------------------------------- splits -- */

function sheetStatus(parties: Array<{ signedAt: Date | null }>, sent: boolean) {
  const signed = parties.filter((p) => p.signedAt).length;
  if (parties.length > 0 && signed === parties.length) return 'signed';
  if (signed > 0) return 'partly_signed';
  return sent ? 'sent' : 'draft';
}

/** Replace a track's split sheet. Changing shares voids existing signatures. */
export async function saveSplitSheet(ctx: ServiceContext, trackId: string, input: z.input<typeof SplitSheetInput>) {
  ctx.assert('catalogue:write');
  const data = SplitSheetInput.parse(input);
  const total = data.parties.reduce((n, p) => n + p.sharePct, 0);
  if (Math.abs(total - 100) > 0.01) throw new ValidationError(`Shares add up to ${Number(total.toFixed(3))}%, not 100%`);
  const t = await getTrackRow(ctx, trackId);
  const [existing] = await ctx.tx.select().from(splitSheets).where(and(eq(splitSheets.trackId, trackId), eq(splitSheets.kind, data.kind)));
  const before = existing ? await ctx.tx.select().from(splitParties).where(eq(splitParties.sheetId, existing.id)) : [];
  const [sheet] = existing
    ? await ctx.tx.update(splitSheets).set({ status: data.send ? 'sent' : 'draft', sentAt: data.send ? new Date() : existing.sentAt }).where(eq(splitSheets.id, existing.id)).returning()
    : await ctx.tx.insert(splitSheets).values({ trackId, kind: data.kind, status: data.send ? 'sent' : 'draft', sentAt: data.send ? new Date() : null }).returning();
  if (existing) await ctx.tx.delete(splitParties).where(eq(splitParties.sheetId, sheet.id));
  await ctx.tx.insert(splitParties).values(data.parties.map((p) => ({ sheetId: sheet.id, name: p.name, email: p.email ?? null, artistId: p.artistId ?? null, sharePct: String(p.sharePct) })));
  await recomputeBlockers(ctx, trackId);
  await ctx.audit({ action: 'split.changed', module: 'catalogue', targetType: 'track', targetId: trackId, targetLabel: t.title, before: { parties: before.map((p) => `${p.name} ${p.sharePct}%`) } as never, after: { parties: data.parties.map((p) => `${p.name} ${p.sharePct}%`) } as never });
  return sheet;
}

export async function setPartySigned(ctx: ServiceContext, partyId: string, signed: boolean) {
  ctx.assert('catalogue:write');
  const [party] = await ctx.tx.update(splitParties).set({ signedAt: signed ? new Date() : null }).where(eq(splitParties.id, partyId)).returning();
  if (!party) throw new NotFoundError('Split party');
  const [sheet] = await ctx.tx.select().from(splitSheets).where(eq(splitSheets.id, party.sheetId));
  const parties = await ctx.tx.select().from(splitParties).where(eq(splitParties.sheetId, sheet.id));
  await ctx.tx.update(splitSheets).set({ status: sheetStatus(parties, Boolean(sheet.sentAt)) }).where(eq(splitSheets.id, sheet.id));
  await recomputeBlockers(ctx, sheet.trackId);
  await ctx.audit({ action: signed ? 'split.signed' : 'split.unsigned', module: 'catalogue', targetType: 'track', targetId: sheet.trackId, targetLabel: party.name });
  return party;
}

/** Split sheets across the catalogue, for Finance → Splits. */
export async function listSplitSheets(ctx: ServiceContext) {
  ctx.assert('catalogue:read');
  const sheets = await ctx.tx
    .select({ sheet: splitSheets, trackTitle: tracks.title, trackId: tracks.id })
    .from(splitSheets)
    .innerJoin(tracks, eq(tracks.id, splitSheets.trackId))
    .orderBy(sql`case ${splitSheets.status} when 'signed' then 1 else 0 end`, asc(splitSheets.sentAt));
  if (sheets.length === 0) return [];
  const [parties, rel] = await Promise.all([
    ctx.tx.select().from(splitParties).where(inArray(splitParties.sheetId, sheets.map((s) => s.sheet.id))),
    ctx.tx.select({ trackId: releaseTracks.trackId, title: releases.title }).from(releaseTracks).innerJoin(releases, eq(releases.id, releaseTracks.releaseId)).where(inArray(releaseTracks.trackId, sheets.map((s) => s.trackId))),
  ]);
  return sheets.map((s) => ({ ...s.sheet, trackTitle: s.trackTitle, releaseTitle: rel.find((r) => r.trackId === s.trackId)?.title ?? null, parties: parties.filter((p) => p.sheetId === s.sheet.id).sort((a, b) => Number(b.sharePct) - Number(a.sharePct)) }));
}
