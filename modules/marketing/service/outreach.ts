import '../types';
import { and, desc, eq, inArray, sql } from 'drizzle-orm';
import { z } from 'zod';
import { patchOf } from '@labelconsole/core/zod';
import type { ServiceContext } from '@labelconsole/core/context';
import { ConflictError, NotFoundError, ValidationError } from '@labelconsole/core/errors';
import { enqueueAfterCommit } from '@labelconsole/core/queue';
import { tracks } from '@labelconsole/catalogue/schema';
import { contacts, playlists } from '@labelconsole/network/schema';
import { campaigns, PITCH_STATUSES, pitches } from '../schema';

export const PitchInput = z.object({
  contactId: z.uuid(),
  campaignId: z.uuid().nullable().optional(),
  playlistId: z.uuid().nullable().optional(),
  trackId: z.uuid().nullable().optional(),
  subject: z.string().trim().min(1).max(300),
  body: z.string().trim().min(1).max(20_000),
});
export const PitchPatch = patchOf(PitchInput.omit({ contactId: true }));

/** Pitches can be edited until they go out. */
const EDITABLE = ['draft', 'approved'];

export async function createPitch(ctx: ServiceContext, input: z.input<typeof PitchInput>) {
  ctx.assert('marketing:write');
  const data = PitchInput.parse(input);
  const [c] = await ctx.tx.select().from(contacts).where(eq(contacts.id, data.contactId));
  if (!c) throw new ValidationError('That contact does not exist', { fieldErrors: { contactId: ['Unknown contact'] } });
  if (c.stage === 'do_not_contact') throw new ConflictError(`${c.name} asked not to be contacted`);
  const [row] = await ctx.tx.insert(pitches).values({ ...data, status: 'draft', agentRunId: ctx.actor.type === 'agent' ? ctx.actor.runId : null }).returning();
  await ctx.audit({ action: 'pitch.drafted', module: 'marketing', targetType: 'pitch', targetId: row.id, targetLabel: `${c.name}: ${row.subject}` });
  return row;
}

export async function getPitchRow(ctx: ServiceContext, id: string) {
  ctx.assert('marketing:read');
  const [row] = await ctx.tx.select().from(pitches).where(eq(pitches.id, id));
  if (!row) throw new NotFoundError('Pitch');
  return row;
}

export async function updatePitch(ctx: ServiceContext, id: string, patch: z.input<typeof PitchPatch>) {
  ctx.assert('marketing:write');
  const before = await getPitchRow(ctx, id);
  if (!EDITABLE.includes(before.status)) throw new ConflictError('This pitch has already been sent');
  const [after] = await ctx.tx.update(pitches).set(PitchPatch.parse(patch)).where(eq(pitches.id, id)).returning();
  return after;
}

/**
 * Send a pitch by email. A person pressing Send is the approval; agents reach
 * this through `marketing_send_outreach`, which always waits for a human
 * approval first. The send itself happens in the worker, once.
 */
export async function sendPitch(ctx: ServiceContext, id: string) {
  ctx.assert('marketing:write');
  const p = await getPitchRow(ctx, id);
  if (p.status === 'sent' || p.sentAt) throw new ConflictError('This pitch has already been sent');
  if (!EDITABLE.includes(p.status)) throw new ConflictError(`A ${p.status} pitch can't be sent`);
  const [c] = await ctx.tx.select().from(contacts).where(eq(contacts.id, p.contactId));
  if (!c?.email) throw new ValidationError(`${c?.name ?? 'This contact'} has no email address on file`);
  if (c.stage === 'do_not_contact') throw new ConflictError(`${c.name} asked not to be contacted`);
  if (c.goneAt) throw new ConflictError(`${c.name}'s account is gone`);
  if (!p.subject || !p.body) throw new ValidationError('Write a subject and a message first');
  const [row] = await ctx.tx.update(pitches).set({ status: 'approved', outcome: null }).where(eq(pitches.id, id)).returning();
  // The key is the pitch itself: the job checks sent_at, so a retry or a double click never sends twice.
  enqueueAfterCommit(ctx, 'marketing.send-pitch', { pitchId: id, idempotencyKey: `pitch:${id}` }, { jobId: `send-pitch-${id}`, attempts: 3, backoff: { type: 'exponential', delay: 30_000 } });
  await ctx.audit({ action: 'pitch.send_requested', module: 'marketing', targetType: 'pitch', targetId: id, targetLabel: `${c.name}: ${p.subject}` });
  return row;
}

export const OutcomeInput = z.object({ status: z.enum(['opened', 'replied', 'accepted', 'declined']), outcome: z.string().max(2000).nullable().optional() });

export async function setPitchOutcome(ctx: ServiceContext, id: string, input: z.input<typeof OutcomeInput>) {
  ctx.assert('marketing:write');
  const data = OutcomeInput.parse(input);
  const p = await getPitchRow(ctx, id);
  if (!p.sentAt) throw new ConflictError('Send the pitch before recording a response');
  const [after] = await ctx.tx
    .update(pitches)
    .set({ status: data.status, outcome: data.outcome ?? p.outcome, repliedAt: data.status === 'opened' ? p.repliedAt : (p.repliedAt ?? new Date()) })
    .where(eq(pitches.id, id))
    .returning();
  await ctx.audit({ action: 'pitch.outcome', module: 'marketing', targetType: 'pitch', targetId: id, before: { status: p.status }, after: { status: data.status } });
  return after;
}

export async function deletePitch(ctx: ServiceContext, id: string) {
  ctx.assert('marketing:write');
  const p = await getPitchRow(ctx, id);
  if (p.sentAt) throw new ConflictError('Sent pitches stay on record');
  await ctx.tx.delete(pitches).where(eq(pitches.id, id));
}

export const PitchQuery = z.object({ status: z.enum(PITCH_STATUSES).optional(), campaignId: z.uuid().optional(), contactId: z.uuid().optional() });

export async function listPitches(ctx: ServiceContext, q: Partial<z.infer<typeof PitchQuery>> = {}) {
  ctx.assert('marketing:read');
  const conds = [];
  if (q.status) conds.push(eq(pitches.status, q.status));
  if (q.campaignId) conds.push(eq(pitches.campaignId, q.campaignId));
  if (q.contactId) conds.push(eq(pitches.contactId, q.contactId));
  return ctx.tx
    .select({ pitch: pitches, contactName: contacts.name, contactType: contacts.type, contactEmail: contacts.email, playlistName: playlists.name, playlistFollowers: playlists.followers, trackTitle: tracks.title, campaignName: campaigns.name })
    .from(pitches)
    .innerJoin(contacts, eq(contacts.id, pitches.contactId))
    .leftJoin(playlists, eq(playlists.id, pitches.playlistId))
    .leftJoin(tracks, eq(tracks.id, pitches.trackId))
    .leftJoin(campaigns, eq(campaigns.id, pitches.campaignId))
    .where(conds.length ? and(...conds) : undefined)
    .orderBy(sql`case ${pitches.status} when 'draft' then 0 when 'approved' then 1 else 2 end`, desc(pitches.updatedAt))
    .limit(1000);
}

export async function pitchCounts(ctx: ServiceContext, campaignIds?: string[]) {
  const rows = await ctx.tx
    .select({ status: pitches.status, n: sql<number>`count(*)::int` })
    .from(pitches)
    .where(campaignIds?.length ? inArray(pitches.campaignId, campaignIds) : undefined)
    .groupBy(pitches.status);
  return Object.fromEntries(rows.map((r) => [r.status, r.n])) as Partial<Record<(typeof PITCH_STATUSES)[number], number>>;
}
