import '../types';
import { and, asc, eq, ilike, inArray, or, sql } from 'drizzle-orm';
import { z } from 'zod';
import type { ServiceContext } from '@labelconsole/core/context';
import { memberships, users } from '@labelconsole/core/db/schema';
import { NotFoundError } from '@labelconsole/core/errors';
import { ROLE_LABELS, type BuiltInRole } from '@labelconsole/core/permissions';
import { ARTIST_STATUSES, ONBOARDING_STEPS, artists, staffMembers, type Artist, type Onboarding } from '../schema';

/* ------------------------------------------------------------ schemas -- */

const Socials = z.object({ instagram: z.string(), tiktok: z.string(), x: z.string(), youtube: z.string(), website: z.string(), soundcloud: z.string() }).partial();

export const ArtistInput = z.object({
  name: z.string().trim().min(1).max(200),
  aliases: z.array(z.string().trim().min(1)).max(20).default([]),
  legalName: z.string().trim().max(200).nullable().optional(),
  status: z.enum(ARTIST_STATUSES).default('prospect'),
  country: z.string().trim().max(2).toUpperCase().nullable().optional(),
  email: z.email().nullable().optional(),
  manager: z.string().trim().max(200).nullable().optional(),
  bio: z.string().max(5000).nullable().optional(),
  socials: Socials.default({}),
  spotifyArtistId: z.string().trim().max(64).nullable().optional(),
  youtubeChannelId: z.string().trim().max(64).nullable().optional(),
  payoutMethod: z.enum(['bank', 'paypal', 'none']).default('none'),
  rosterSince: z.iso.date().nullable().optional(),
  notes: z.string().max(5000).nullable().optional(),
});
export const ArtistPatch = ArtistInput.partial();

export const OnboardingPatch = z.object({
  profile: z.boolean(),
  taxForm: z.boolean(),
  payout: z.boolean(),
  contract: z.boolean(),
  assets: z.boolean(),
  next: z.string().max(300),
  ownerId: z.uuid().nullable(),
}).partial();

export const ListQuery = z.object({
  q: z.string().trim().max(100).optional(),
  status: z.enum(ARTIST_STATUSES).optional(),
  limit: z.coerce.number().int().min(1).max(500).default(200),
});

/* ------------------------------------------------------------ artists -- */

/** Artist-scoped members only see their own roster. */
function scopeCondition(ctx: ServiceContext) {
  return ctx.artistScope ? inArray(artists.id, [...ctx.artistScope]) : undefined;
}

export async function listArtists(ctx: ServiceContext, q: Partial<z.infer<typeof ListQuery>> = {}) {
  ctx.assert('people:read');
  const conds = [scopeCondition(ctx)];
  if (q.status) conds.push(eq(artists.status, q.status));
  if (q.q) conds.push(or(ilike(artists.name, `%${q.q}%`), ilike(artists.legalName, `%${q.q}%`), sql`${q.q} ilike any(${artists.aliases})`));
  return ctx.tx
    .select()
    .from(artists)
    .where(and(...conds.filter(Boolean)))
    .orderBy(asc(artists.name))
    .limit(q.limit ?? 200);
}

export async function getArtist(ctx: ServiceContext, id: string): Promise<Artist> {
  ctx.assert('people:read');
  const [row] = await ctx.tx.select().from(artists).where(and(eq(artists.id, id), scopeCondition(ctx)));
  if (!row) throw new NotFoundError('Artist');
  return row;
}

export async function getArtistsByIds(ctx: ServiceContext, ids: string[]) {
  if (ids.length === 0) return [];
  return ctx.tx.select().from(artists).where(and(inArray(artists.id, ids), scopeCondition(ctx)));
}

/** Find by name or alias (case-insensitive); used by imports to avoid duplicates. */
export async function findArtistByName(ctx: ServiceContext, name: string) {
  const [row] = await ctx.tx
    .select()
    .from(artists)
    .where(or(sql`lower(${artists.name}) = lower(${name})`, sql`lower(${name}) = any(select lower(a) from unnest(${artists.aliases}) a)`))
    .limit(1);
  return row ?? null;
}

export async function createArtist(ctx: ServiceContext, input: z.input<typeof ArtistInput>) {
  ctx.assert('people:write');
  const data = ArtistInput.parse(input);
  const onboarding: Onboarding = data.status === 'onboarding' ? { profile: Boolean(data.legalName && data.email && data.country) } : {};
  const [row] = await ctx.tx
    .insert(artists)
    .values({ ...data, onboarding, onboardingStartedAt: data.status === 'onboarding' ? new Date() : null })
    .returning();
  await ctx.audit({ action: 'artist.created', module: 'people', targetType: 'artist', targetId: row.id, targetLabel: row.name, after: { name: row.name, status: row.status } });
  await ctx.emit('people.artist.created', { artistId: row.id, name: row.name });
  return row;
}

/** Ensure an artist exists by name (imports, intake); returns the existing one when found. */
export async function ensureArtist(ctx: ServiceContext, name: string) {
  const existing = await findArtistByName(ctx, name);
  if (existing) return existing;
  return createArtist(ctx, { name, status: 'prospect' });
}

export async function updateArtist(ctx: ServiceContext, id: string, patch: z.input<typeof ArtistPatch>) {
  ctx.assert('people:write');
  const before = await getArtist(ctx, id);
  const data = ArtistPatch.parse(patch);
  const set: Partial<typeof artists.$inferInsert> = { ...data };
  if (data.status === 'onboarding' && before.status !== 'onboarding') set.onboardingStartedAt = new Date();
  const [after] = await ctx.tx.update(artists).set(set).where(eq(artists.id, id)).returning();
  const changed = Object.keys(data).filter((k) => JSON.stringify((before as Record<string, unknown>)[k]) !== JSON.stringify((after as Record<string, unknown>)[k]));
  if (changed.length === 0) return after;
  await ctx.audit({ action: data.status && data.status !== before.status ? 'artist.status_changed' : 'artist.updated', module: 'people', targetType: 'artist', targetId: id, targetLabel: after.name, before: before as never, after: after as never });
  await ctx.emit('people.artist.updated', { artistId: id, name: after.name, changed });
  if (data.status && data.status !== before.status) await ctx.emit('people.artist.status_changed', { artistId: id, name: after.name, from: before.status, to: after.status });
  return after;
}

export async function deleteArtist(ctx: ServiceContext, id: string) {
  ctx.assert('people:delete');
  const before = await getArtist(ctx, id);
  await ctx.tx.delete(artists).where(eq(artists.id, id));
  await ctx.audit({ action: 'artist.deleted', module: 'people', targetType: 'artist', targetId: id, targetLabel: before.name, before: { name: before.name, status: before.status } });
}

/* --------------------------------------------------------- onboarding -- */

export function onboardingProgress(o: Onboarding) {
  const done = ONBOARDING_STEPS.filter((s) => o[s]).length;
  return { done, total: ONBOARDING_STEPS.length, steps: ONBOARDING_STEPS.map((s) => Boolean(o[s])) };
}

export function nextStepFor(a: Pick<Artist, 'onboarding' | 'payoutMethod'>) {
  const o = a.onboarding;
  if (o.next) return o.next;
  if (!o.profile) return 'Complete artist profile (legal name, email, country)';
  if (!o.taxForm) return 'Tax form outstanding';
  if (!o.payout) return 'Payout details missing';
  if (!o.contract) return 'Contract not signed';
  if (!o.assets) return 'Upload stems, artwork and press assets';
  return 'Ready to move to active';
}

export async function updateOnboarding(ctx: ServiceContext, id: string, patch: z.infer<typeof OnboardingPatch>) {
  ctx.assert('people:write');
  const before = await getArtist(ctx, id);
  const { ownerId, ...steps } = patch;
  const onboarding: Onboarding = { ...before.onboarding, ...steps };
  if (patch.next === '') delete onboarding.next;
  const [after] = await ctx.tx
    .update(artists)
    .set({ onboarding, ...(ownerId !== undefined ? { onboardingOwnerId: ownerId } : {}) })
    .where(eq(artists.id, id))
    .returning();
  await ctx.audit({ action: 'artist.onboarding_updated', module: 'people', targetType: 'artist', targetId: id, targetLabel: after.name, before: before.onboarding as never, after: after.onboarding as never });
  return after;
}

export async function onboardingBoard(ctx: ServiceContext) {
  const rows = await listArtists(ctx, { status: 'onboarding' });
  const ownerIds = [...new Set(rows.map((r) => r.onboardingOwnerId).filter((x): x is string => Boolean(x)))];
  const owners = ownerIds.length ? await ctx.tx.select({ id: users.id, name: users.name }).from(users).where(inArray(users.id, ownerIds)) : [];
  return rows.map((a) => ({ artist: a, owner: owners.find((o) => o.id === a.onboardingOwnerId)?.name ?? null, ...onboardingProgress(a.onboarding), next: nextStepFor(a) }));
}

/* -------------------------------------------------------------- staff -- */

export const StaffPatch = z.object({ title: z.string().trim().max(120).nullable(), department: z.string().trim().max(120).nullable(), phone: z.string().trim().max(40).nullable(), bio: z.string().max(2000).nullable() }).partial();

export async function listStaff(ctx: ServiceContext) {
  ctx.assert('people:read');
  const rows = await ctx.tx
    .select({ userId: users.id, name: users.name, email: users.email, role: memberships.role, lastActiveAt: users.lastActiveAt, profile: staffMembers })
    .from(memberships)
    .innerJoin(users, eq(users.id, memberships.userId))
    .leftJoin(staffMembers, and(eq(staffMembers.userId, users.id), eq(staffMembers.orgId, memberships.orgId)))
    .where(eq(memberships.status, 'active'))
    .orderBy(asc(users.name));
  return rows.map((r) => ({ ...r, roleLabel: ROLE_LABELS[r.role as BuiltInRole] ?? r.role }));
}

export async function upsertStaffProfile(ctx: ServiceContext, userId: string, patch: z.infer<typeof StaffPatch>) {
  if (!(ctx.actor.type === 'user' && ctx.actor.id === userId)) ctx.assert('people:write');
  const [existing] = await ctx.tx.select().from(staffMembers).where(eq(staffMembers.userId, userId));
  const [row] = existing
    ? await ctx.tx.update(staffMembers).set(patch).where(eq(staffMembers.id, existing.id)).returning()
    : await ctx.tx.insert(staffMembers).values({ userId, ...patch }).returning();
  await ctx.audit({ action: 'staff.updated', module: 'people', targetType: 'staff', targetId: userId, before: existing as never, after: row as never });
  return row;
}

/* ---------------------------------------------------------- dashboard -- */

export async function rosterCounts(ctx: ServiceContext) {
  const rows = await ctx.tx.select({ status: artists.status, n: sql<number>`count(*)::int` }).from(artists).where(scopeCondition(ctx)).groupBy(artists.status);
  return Object.fromEntries(rows.map((r) => [r.status, r.n])) as Partial<Record<(typeof ARTIST_STATUSES)[number], number>>;
}
