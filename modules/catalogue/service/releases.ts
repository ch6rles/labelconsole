import { and, asc, desc, eq, ilike, inArray, or, sql } from 'drizzle-orm';
import { z } from 'zod';
import { patchOf } from '@labelconsole/core/zod';
import type { ServiceContext } from '@labelconsole/core/context';
import { NotFoundError } from '@labelconsole/core/errors';
import { artists } from '@labelconsole/people/schema';
import { RELEASE_STATUSES, RELEASE_TYPES, platformIdentities, releaseArtists, releaseTracks, releases, tracks, type ChecklistItem, type Release } from '../schema';
import { today, upcField } from './shared';

export const ReleaseInput = z.object({
  title: z.string().trim().min(1).max(300),
  type: z.enum(RELEASE_TYPES).default('single'),
  upc: upcField.optional(),
  catalogNumber: z.string().trim().max(40).nullable().optional(),
  releaseDate: z.iso.date().nullable().optional(),
  labelName: z.string().trim().max(200).nullable().optional(),
  distributor: z.string().trim().max(120).nullable().optional(),
  status: z.enum(RELEASE_STATUSES).default('collecting'),
  pLine: z.string().trim().max(300).nullable().optional(),
  cLine: z.string().trim().max(300).nullable().optional(),
  genre: z.string().trim().max(80).nullable().optional(),
  notes: z.string().max(5000).nullable().optional(),
  artistIds: z.array(z.uuid()).max(20).optional(),
});
export const ReleasePatch = patchOf(ReleaseInput).extend({ artworkFileId: z.uuid().nullable().optional() });

/** Manual checklist steps every release starts with; automatic checks are computed. */
export const DEFAULT_CHECKLIST: ChecklistItem[] = [
  { id: 'metadata_reviewed', label: 'Metadata reviewed', done: false },
  { id: 'delivered', label: 'Delivered to distributor', done: false },
  { id: 'pitch', label: 'Editorial pitch submitted', done: false },
];

export type Readiness = { label: string; tone: 'wait' | 'blocked' | 'ready'; pct: number; trackCount: number; blockedTracks: number; blockers: string[] };

export function computeReadiness(r: Pick<Release, 'intake' | 'artworkFileId' | 'upc' | 'releaseDate' | 'checklist'>, trackBlockers: string[][]): Readiness {
  const trackCount = trackBlockers.length;
  const blockedTracks = trackBlockers.filter((b) => b.length > 0).length;
  const blockers: string[] = [];
  if (!r.artworkFileId) blockers.push('Artwork missing');
  if (!r.releaseDate) blockers.push('No release date');
  if (!r.upc) blockers.push('No UPC');
  const auto = [Boolean(r.artworkFileId), Boolean(r.releaseDate), Boolean(r.upc), trackCount > 0, trackCount > 0 && blockedTracks === 0];
  const manual = r.checklist.map((c) => c.done);
  const all = [...auto, ...manual];
  const pct = Math.round((all.filter(Boolean).length / all.length) * 100);
  if (trackCount === 0) return { label: r.intake ? 'Awaiting intake' : 'No tracks yet', tone: 'wait', pct: r.intake ? 0 : pct, trackCount, blockedTracks, blockers };
  if (blockedTracks > 0) return { label: `Blocked by ${blockedTracks} track${blockedTracks === 1 ? '' : 's'}`, tone: 'blocked', pct, trackCount, blockedTracks, blockers };
  if (blockers.length) return { label: blockers[0], tone: 'blocked', pct, trackCount, blockedTracks, blockers };
  return { label: `All ${trackCount} ready`, tone: 'ready', pct, trackCount, blockedTracks, blockers };
}

export const ListReleasesQuery = z.object({
  q: z.string().trim().max(100).optional(),
  type: z.enum(RELEASE_TYPES).optional(),
  status: z.enum(RELEASE_STATUSES).optional(),
  artistId: z.uuid().optional(),
});

export async function listReleases(ctx: ServiceContext, q: z.infer<typeof ListReleasesQuery> = {}) {
  ctx.assert('catalogue:read');
  const conds = [];
  if (q.type) conds.push(eq(releases.type, q.type));
  if (q.status) conds.push(eq(releases.status, q.status));
  if (q.q) conds.push(or(ilike(releases.title, `%${q.q}%`), ilike(releases.upc, `%${q.q.replace(/\D/g, '') || q.q}%`), ilike(releases.catalogNumber, `%${q.q}%`)));
  if (q.artistId) conds.push(inArray(releases.id, ctx.tx.select({ id: releaseArtists.releaseId }).from(releaseArtists).where(eq(releaseArtists.artistId, q.artistId))));
  if (ctx.artistScope) conds.push(inArray(releases.id, ctx.tx.select({ id: releaseArtists.releaseId }).from(releaseArtists).where(inArray(releaseArtists.artistId, [...ctx.artistScope]))));
  const rows = await ctx.tx.select().from(releases).where(conds.length ? and(...conds) : undefined).orderBy(sql`${releases.releaseDate} desc nulls first`, desc(releases.createdAt)).limit(1000);
  if (rows.length === 0) return [];
  const ids = rows.map((r) => r.id);
  const [trackRows, artistRows] = await Promise.all([
    ctx.tx.select({ releaseId: releaseTracks.releaseId, blockers: tracks.blockers }).from(releaseTracks).innerJoin(tracks, eq(tracks.id, releaseTracks.trackId)).where(inArray(releaseTracks.releaseId, ids)),
    ctx.tx.select({ releaseId: releaseArtists.releaseId, id: artists.id, name: artists.name }).from(releaseArtists).innerJoin(artists, eq(artists.id, releaseArtists.artistId)).where(inArray(releaseArtists.releaseId, ids)).orderBy(asc(releaseArtists.position)),
  ]);
  const t = today();
  return rows.map((r) => {
    const readiness = computeReadiness(r, trackRows.filter((x) => x.releaseId === r.id).map((x) => x.blockers));
    const released = r.status === 'live' || r.status === 'taken_down' || (r.releaseDate != null && r.releaseDate < t && r.status !== 'collecting');
    return { ...r, artists: artistRows.filter((a) => a.releaseId === r.id).map((a) => ({ id: a.id, name: a.name })), readiness, upcoming: !released };
  });
}

export async function getReleaseRow(ctx: ServiceContext, id: string) {
  ctx.assert('catalogue:read');
  const [r] = await ctx.tx.select().from(releases).where(eq(releases.id, id));
  if (!r) throw new NotFoundError('Release');
  return r;
}

export async function getRelease(ctx: ServiceContext, id: string) {
  const r = await getReleaseRow(ctx, id);
  const [trackRows, artistRows, identities] = await Promise.all([
    ctx.tx.select({ link: releaseTracks, track: tracks }).from(releaseTracks).innerJoin(tracks, eq(tracks.id, releaseTracks.trackId)).where(eq(releaseTracks.releaseId, id)).orderBy(asc(releaseTracks.disc), asc(releaseTracks.position)),
    ctx.tx.select({ id: artists.id, name: artists.name, role: releaseArtists.role }).from(releaseArtists).innerJoin(artists, eq(artists.id, releaseArtists.artistId)).where(eq(releaseArtists.releaseId, id)).orderBy(asc(releaseArtists.position)),
    ctx.tx.select().from(platformIdentities).where(and(eq(platformIdentities.entityType, 'release'), eq(platformIdentities.entityId, id))),
  ]);
  const readiness = computeReadiness(r, trackRows.map((t) => t.track.blockers));
  return { release: r, tracks: trackRows.map((t) => ({ ...t.track, position: t.link.position, disc: t.link.disc })), artists: artistRows, identities, readiness };
}

async function setReleaseArtists(ctx: ServiceContext, releaseId: string, artistIds: string[]) {
  await ctx.tx.delete(releaseArtists).where(eq(releaseArtists.releaseId, releaseId));
  if (artistIds.length) await ctx.tx.insert(releaseArtists).values(artistIds.map((artistId, i) => ({ releaseId, artistId, role: i === 0 ? 'primary' : 'featured', position: i })));
}

export async function createRelease(ctx: ServiceContext, input: z.input<typeof ReleaseInput> & { intake?: boolean; distributorConfidence?: number | null; distributorEvidence?: Release['distributorEvidence'] }) {
  ctx.assert('catalogue:write');
  const { artistIds, ...data } = ReleaseInput.parse(input);
  const [row] = await ctx.tx
    .insert(releases)
    .values({ ...data, upc: data.upc ?? null, intake: input.intake ?? false, checklist: DEFAULT_CHECKLIST, distributorConfidence: input.distributorConfidence != null ? String(input.distributorConfidence) : null, distributorEvidence: input.distributorEvidence ?? null })
    .returning();
  if (artistIds?.length) await setReleaseArtists(ctx, row.id, artistIds);
  await ctx.audit({ action: 'release.created', module: 'catalogue', targetType: 'release', targetId: row.id, targetLabel: row.title, after: { title: row.title, type: row.type, upc: row.upc, releaseDate: row.releaseDate } });
  await ctx.emit('catalogue.release.created', { releaseId: row.id, title: row.title, type: row.type, releaseDate: row.releaseDate });
  return row;
}

export async function updateRelease(ctx: ServiceContext, id: string, patch: z.input<typeof ReleasePatch>) {
  ctx.assert('catalogue:write');
  const before = await getReleaseRow(ctx, id);
  const { artistIds, ...data } = ReleasePatch.parse(patch);
  const [after] = Object.keys(data).length ? await ctx.tx.update(releases).set(data).where(eq(releases.id, id)).returning() : [before];
  if (artistIds) await setReleaseArtists(ctx, id, artistIds);
  const changed = Object.keys(data).filter((k) => JSON.stringify((before as Record<string, unknown>)[k]) !== JSON.stringify((after as Record<string, unknown>)[k]));
  if (artistIds) changed.push('artists');
  if (changed.length) {
    await ctx.audit({ action: 'release.updated', module: 'catalogue', targetType: 'release', targetId: id, targetLabel: after.title, before: before as never, after: after as never });
    await ctx.emit('catalogue.release.updated', { releaseId: id, title: after.title, changed });
  }
  return after;
}

export async function deleteRelease(ctx: ServiceContext, id: string) {
  ctx.assert('catalogue:delete');
  const before = await getReleaseRow(ctx, id);
  await ctx.tx.delete(releases).where(eq(releases.id, id));
  await ctx.tx.delete(platformIdentities).where(and(eq(platformIdentities.entityType, 'release'), eq(platformIdentities.entityId, id)));
  await ctx.audit({ action: 'release.deleted', module: 'catalogue', targetType: 'release', targetId: id, targetLabel: before.title, before: { title: before.title, upc: before.upc } });
}

export async function setChecklistItem(ctx: ServiceContext, id: string, input: { itemId: string; done?: boolean; label?: string; remove?: boolean }) {
  ctx.assert('catalogue:write');
  const r = await getReleaseRow(ctx, id);
  let list = [...r.checklist];
  const existing = list.find((c) => c.id === input.itemId);
  if (input.remove) list = list.filter((c) => c.id !== input.itemId);
  else if (existing) list = list.map((c) => (c.id === input.itemId ? { ...c, done: input.done ?? c.done, label: input.label ?? c.label, doneAt: input.done ? new Date().toISOString() : input.done === false ? null : c.doneAt } : c));
  else if (input.label) list.push({ id: input.itemId, label: input.label, done: Boolean(input.done), doneAt: input.done ? new Date().toISOString() : null });
  const [after] = await ctx.tx.update(releases).set({ checklist: list }).where(eq(releases.id, id)).returning();
  await ctx.audit({ action: 'release.checklist_updated', module: 'catalogue', targetType: 'release', targetId: id, targetLabel: r.title, before: { checklist: r.checklist } as never, after: { checklist: list } as never });
  return after;
}

export async function linkTrack(ctx: ServiceContext, releaseId: string, trackId: string, position?: number) {
  ctx.assert('catalogue:write');
  const [{ n }] = await ctx.tx.select({ n: sql<number>`count(*)::int` }).from(releaseTracks).where(eq(releaseTracks.releaseId, releaseId));
  await ctx.tx.insert(releaseTracks).values({ releaseId, trackId, position: position ?? n + 1 }).onConflictDoUpdate({ target: [releaseTracks.releaseId, releaseTracks.trackId], set: { position: position ?? n } });
}

export async function unlinkTrack(ctx: ServiceContext, releaseId: string, trackId: string) {
  ctx.assert('catalogue:write');
  await ctx.tx.delete(releaseTracks).where(and(eq(releaseTracks.releaseId, releaseId), eq(releaseTracks.trackId, trackId)));
}

export async function reorderTracks(ctx: ServiceContext, releaseId: string, trackIds: string[]) {
  ctx.assert('catalogue:write');
  for (const [i, trackId] of trackIds.entries()) await ctx.tx.update(releaseTracks).set({ position: i + 1 }).where(and(eq(releaseTracks.releaseId, releaseId), eq(releaseTracks.trackId, trackId)));
}

export async function findReleaseByUpc(ctx: ServiceContext, upc: string) {
  const [r] = await ctx.tx.select().from(releases).where(eq(releases.upc, upc));
  return r ?? null;
}
