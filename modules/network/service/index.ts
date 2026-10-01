import '../types';
import { and, arrayOverlaps, asc, desc, eq, gte, ilike, inArray, isNull, or, sql } from 'drizzle-orm';
import { z } from 'zod';
import { patchOf } from '@labelconsole/core/zod';
import type { ServiceContext } from '@labelconsole/core/context';
import { ConflictError, NotFoundError } from '@labelconsole/core/errors';
import { CONTACT_STAGES, CONTACT_TYPES, contacts, interactions, playlists, type Contact } from '../schema';

/* ----------------------------------------------------------- contacts --- */

const Handles = z.object({ instagram: z.string(), tiktok: z.string(), youtube: z.string(), x: z.string(), spotify: z.string(), twitch: z.string(), website: z.string() }).partial();

export const ContactInput = z.object({
  type: z.enum(CONTACT_TYPES).default('creator'),
  name: z.string().trim().min(1).max(200),
  email: z.email().nullable().optional(),
  organization: z.string().trim().max(200).nullable().optional(),
  handles: Handles.default({}),
  audienceSize: z.number().int().min(0).nullable().optional(),
  genres: z.array(z.string().trim().min(1).max(40)).max(20).default([]),
  rateCents: z.number().int().min(0).nullable().optional(),
  currency: z.string().length(3).default('USD'),
  stage: z.enum(CONTACT_STAGES).default('lead'),
  country: z.string().trim().max(2).toUpperCase().nullable().optional(),
  payoutEmail: z.email().nullable().optional(),
  notes: z.string().max(5000).nullable().optional(),
});
export const ContactPatch = patchOf(ContactInput);

/** Normalise a social handle so "@Name", "name" and a profile URL compare equal. */
export function normalizeHandle(raw: string) {
  const s = raw.trim();
  const fromUrl = s.match(/^(?:https?:\/\/)?(?:www\.)?(?:instagram\.com|tiktok\.com|x\.com|twitter\.com|youtube\.com|twitch\.tv)\/(?:@)?([A-Za-z0-9._-]+)/i)?.[1];
  return (fromUrl ?? s.replace(/^@/, '')).toLowerCase();
}

function cleanHandles(h: z.infer<typeof Handles>) {
  return Object.fromEntries(Object.entries(h).filter(([, v]) => v && v.trim()).map(([k, v]) => [k, k === 'website' || k === 'spotify' ? v!.trim() : normalizeHandle(v!)]));
}

/** Another contact with the same email or the same handle on the same platform. */
export async function findDuplicate(ctx: ServiceContext, input: { email?: string | null; handles?: Record<string, string> }, exceptId?: string) {
  const conds = [];
  if (input.email) conds.push(sql`lower(${contacts.email}) = lower(${input.email})`);
  for (const [k, v] of Object.entries(input.handles ?? {})) if (v && k !== 'website') conds.push(sql`lower(${contacts.handles} ->> ${k}) = ${v.toLowerCase()}`);
  if (conds.length === 0) return null;
  const [row] = await ctx.tx.select().from(contacts).where(and(or(...conds), exceptId ? sql`${contacts.id} <> ${exceptId}` : undefined)).limit(1);
  return row ?? null;
}

export async function createContact(ctx: ServiceContext, input: z.input<typeof ContactInput>) {
  ctx.assert('network:write');
  const data = ContactInput.parse(input);
  const handles = cleanHandles(data.handles);
  const dupe = await findDuplicate(ctx, { email: data.email, handles });
  if (dupe) throw new ConflictError(`${dupe.name} is already in your network`, { contactId: dupe.id });
  const [row] = await ctx.tx.insert(contacts).values({ ...data, handles }).returning();
  await ctx.audit({ action: 'contact.created', module: 'network', targetType: 'contact', targetId: row.id, targetLabel: row.name });
  await ctx.emit('network.contact.created', { contactId: row.id, name: row.name, type: row.type });
  return row;
}

export async function updateContact(ctx: ServiceContext, id: string, patch: z.input<typeof ContactPatch>) {
  ctx.assert('network:write');
  const before = await getContactRow(ctx, id);
  const data = ContactPatch.parse(patch);
  const handles = data.handles ? cleanHandles(data.handles) : undefined;
  if (data.email || handles) {
    const dupe = await findDuplicate(ctx, { email: data.email, handles }, id);
    if (dupe) throw new ConflictError(`${dupe.name} already has that email or handle`, { contactId: dupe.id });
  }
  const [after] = await ctx.tx.update(contacts).set({ ...data, ...(handles ? { handles } : {}) }).where(eq(contacts.id, id)).returning();
  await ctx.audit({ action: 'contact.updated', module: 'network', targetType: 'contact', targetId: id, targetLabel: after.name, before: before as never, after: after as never });
  return after;
}

/** Account checks: verified means someone confirmed it exists and is who it claims; gone means it no longer exists. */
export async function setAccountState(ctx: ServiceContext, id: string, state: 'verified' | 'gone' | 'unverified') {
  ctx.assert('network:write');
  const c = await getContactRow(ctx, id);
  const set = state === 'verified' ? { verifiedAt: new Date(), goneAt: null } : state === 'gone' ? { goneAt: new Date() } : { verifiedAt: null, goneAt: null };
  const [after] = await ctx.tx.update(contacts).set(set).where(eq(contacts.id, id)).returning();
  await ctx.audit({ action: `contact.${state}`, module: 'network', targetType: 'contact', targetId: id, targetLabel: c.name });
  return after;
}

export async function deleteContact(ctx: ServiceContext, id: string) {
  ctx.assert('network:delete');
  const c = await getContactRow(ctx, id);
  await ctx.tx.delete(contacts).where(eq(contacts.id, id));
  await ctx.audit({ action: 'contact.deleted', module: 'network', targetType: 'contact', targetId: id, targetLabel: c.name });
}

export async function getContactRow(ctx: ServiceContext, id: string) {
  ctx.assert('network:read');
  const [row] = await ctx.tx.select().from(contacts).where(eq(contacts.id, id));
  if (!row) throw new NotFoundError('Contact');
  return row;
}

export async function getContact(ctx: ServiceContext, id: string) {
  const contact = await getContactRow(ctx, id);
  const [history, lists] = await Promise.all([
    ctx.tx.select().from(interactions).where(eq(interactions.contactId, id)).orderBy(desc(interactions.occurredAt)).limit(100),
    ctx.tx.select().from(playlists).where(eq(playlists.contactId, id)).orderBy(desc(playlists.followers)),
  ]);
  return { contact, interactions: history, playlists: lists };
}

export const ContactQuery = z.object({
  q: z.string().trim().max(100).optional(),
  type: z.enum(CONTACT_TYPES).optional(),
  stage: z.enum(CONTACT_STAGES).optional(),
  genre: z.string().trim().max(40).optional(),
  minAudience: z.coerce.number().int().min(0).optional(),
  account: z.enum(['unverified', 'verified', 'gone', 'no_payout']).optional(),
});

export async function listContacts(ctx: ServiceContext, q: Partial<z.infer<typeof ContactQuery>> = {}) {
  ctx.assert('network:read');
  const conds = [];
  if (q.type) conds.push(eq(contacts.type, q.type));
  if (q.stage) conds.push(eq(contacts.stage, q.stage));
  if (q.genre) conds.push(arrayOverlaps(contacts.genres, [q.genre.toLowerCase(), q.genre]));
  if (q.minAudience) conds.push(gte(contacts.audienceSize, q.minAudience));
  if (q.q) conds.push(or(ilike(contacts.name, `%${q.q}%`), ilike(contacts.organization, `%${q.q}%`), ilike(contacts.email, `%${q.q}%`), sql`${contacts.handles}::text ilike ${`%${q.q.replace(/^@/, '')}%`}`));
  if (q.account === 'unverified') conds.push(isNull(contacts.verifiedAt), isNull(contacts.goneAt));
  if (q.account === 'verified') conds.push(sql`${contacts.verifiedAt} is not null`, isNull(contacts.goneAt));
  if (q.account === 'gone') conds.push(sql`${contacts.goneAt} is not null`);
  if (q.account === 'no_payout') conds.push(isNull(contacts.payoutEmail), isNull(contacts.goneAt));
  return ctx.tx
    .select()
    .from(contacts)
    .where(conds.length ? and(...conds) : undefined)
    .orderBy(asc(sql`${contacts.goneAt} is not null`), desc(contacts.audienceSize), asc(contacts.name))
    .limit(1000);
}

export async function contactsByIds(ctx: ServiceContext, ids: string[]) {
  if (ids.length === 0) return [];
  return ctx.tx.select().from(contacts).where(inArray(contacts.id, ids));
}

/** Counts for the Marketing overview and the dashboard. */
export async function networkCounts(ctx: ServiceContext) {
  const [row] = await ctx.tx
    .select({
      total: sql<number>`count(*)::int`,
      creators: sql<number>`count(*) filter (where ${contacts.type} = 'creator' and ${contacts.goneAt} is null)::int`,
      unverifiedCreators: sql<number>`count(*) filter (where ${contacts.type} = 'creator' and ${contacts.verifiedAt} is null and ${contacts.goneAt} is null)::int`,
      noPayout: sql<number>`count(*) filter (where ${contacts.type} = 'creator' and ${contacts.payoutEmail} is null and ${contacts.goneAt} is null)::int`,
      gone: sql<number>`count(*) filter (where ${contacts.goneAt} is not null)::int`,
    })
    .from(contacts);
  return row;
}

/* ------------------------------------------------------- interactions --- */

export const INTERACTION_CHANNELS = ['email', 'dm', 'call', 'meeting', 'note'] as const;
export const InteractionInput = z.object({
  channel: z.enum(INTERACTION_CHANNELS),
  direction: z.enum(['inbound', 'outbound']).default('outbound'),
  summary: z.string().trim().min(1).max(5000),
  campaignId: z.uuid().nullable().optional(),
  occurredAt: z.coerce.date().optional(),
});

export async function logInteraction(ctx: ServiceContext, contactId: string, input: z.input<typeof InteractionInput>) {
  ctx.assert('network:write');
  const data = InteractionInput.parse(input);
  const contact = await getContactRow(ctx, contactId);
  if (contact.stage === 'do_not_contact' && data.direction === 'outbound' && data.channel !== 'note') throw new ConflictError(`${contact.name} asked not to be contacted`);
  const [row] = await ctx.tx
    .insert(interactions)
    .values({ contactId, channel: data.channel, direction: data.direction, summary: data.summary, campaignId: data.campaignId ?? null, agentRunId: ctx.actor.type === 'agent' ? ctx.actor.runId : null, occurredAt: data.occurredAt ?? new Date() })
    .returning();
  // Outreach moves a lead along; a reply means they are engaged.
  const nextStage = data.direction === 'inbound' && ['lead', 'contacted'].includes(contact.stage) ? 'engaged' : data.direction === 'outbound' && contact.stage === 'lead' && data.channel !== 'note' ? 'contacted' : null;
  await ctx.tx.update(contacts).set({ lastContactedAt: data.channel === 'note' ? contact.lastContactedAt : row.occurredAt, ...(nextStage ? { stage: nextStage } : {}) }).where(eq(contacts.id, contactId));
  await ctx.emit('network.interaction.logged', { interactionId: row.id, contactId, channel: row.channel, direction: row.direction, campaignId: row.campaignId });
  return row;
}

export async function interactionsForCampaign(ctx: ServiceContext, campaignId: string) {
  ctx.assert('network:read');
  return ctx.tx
    .select({ interaction: interactions, contactName: contacts.name })
    .from(interactions)
    .innerJoin(contacts, eq(contacts.id, interactions.contactId))
    .where(eq(interactions.campaignId, campaignId))
    .orderBy(desc(interactions.occurredAt))
    .limit(200);
}

/* ---------------------------------------------------------- playlists --- */

export const PlaylistInput = z.object({
  contactId: z.uuid().nullable().optional(),
  platform: z.enum(['spotify', 'apple_music', 'youtube', 'deezer', 'soundcloud', 'other']),
  name: z.string().trim().min(1).max(200),
  url: z.url().nullable().optional(),
  externalId: z.string().trim().max(120).nullable().optional(),
  followers: z.number().int().min(0).nullable().optional(),
  genres: z.array(z.string().trim().min(1).max(40)).max(20).default([]),
});

export const PlaylistPatch = patchOf(PlaylistInput);

export async function listPlaylists(ctx: ServiceContext, q: { q?: string; platform?: string; genre?: string } = {}) {
  ctx.assert('network:read');
  const conds = [];
  if (q.platform) conds.push(eq(playlists.platform, q.platform));
  if (q.genre) conds.push(arrayOverlaps(playlists.genres, [q.genre.toLowerCase(), q.genre]));
  if (q.q) conds.push(or(ilike(playlists.name, `%${q.q}%`), ilike(contacts.name, `%${q.q}%`)));
  return ctx.tx
    .select({ playlist: playlists, curator: contacts.name, curatorStage: contacts.stage })
    .from(playlists)
    .leftJoin(contacts, eq(contacts.id, playlists.contactId))
    .where(conds.length ? and(...conds) : undefined)
    .orderBy(desc(playlists.followers))
    .limit(1000);
}

export async function createPlaylist(ctx: ServiceContext, input: z.input<typeof PlaylistInput>) {
  ctx.assert('network:write');
  const data = PlaylistInput.parse(input);
  if (data.contactId) await getContactRow(ctx, data.contactId);
  const [row] = await ctx.tx.insert(playlists).values(data).returning();
  await ctx.audit({ action: 'playlist.created', module: 'network', targetType: 'playlist', targetId: row.id, targetLabel: row.name });
  return row;
}

export async function updatePlaylist(ctx: ServiceContext, id: string, patch: z.input<typeof PlaylistPatch>) {
  ctx.assert('network:write');
  const data = PlaylistPatch.parse(patch);
  const [row] = await ctx.tx.update(playlists).set(data).where(eq(playlists.id, id)).returning();
  if (!row) throw new NotFoundError('Playlist');
  return row;
}

export async function deletePlaylist(ctx: ServiceContext, id: string) {
  ctx.assert('network:delete');
  await ctx.tx.delete(playlists).where(eq(playlists.id, id));
}

/** What an agent sees about a contact: no payout details. */
export function contactForAgent(c: Contact) {
  return { id: c.id, type: c.type, name: c.name, organization: c.organization, handles: c.handles, audienceSize: c.audienceSize, genres: c.genres, rate: c.rateCents != null ? `${(c.rateCents / 100).toFixed(2)} ${c.currency}` : null, stage: c.stage, country: c.country, verified: Boolean(c.verifiedAt), gone: Boolean(c.goneAt), hasEmail: Boolean(c.email), lastContactedAt: c.lastContactedAt };
}
