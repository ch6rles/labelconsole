import '../types';
import { and, asc, desc, eq, gte, sql } from 'drizzle-orm';
import { z } from 'zod';
import { patchOf } from '@labelconsole/core/zod';
import type { ServiceContext } from '@labelconsole/core/context';
import { ForbiddenError, NotFoundError, ValidationError } from '@labelconsole/core/errors';
import { contacts } from '@labelconsole/network/schema';
import { boards, campaigns, cards, DEFAULT_CREATOR_STAGES, type Stage } from '../schema';

export const BOARD_KINDS = ['creator', 'editor', 'playlist', 'custom'] as const;

export const DEFAULT_STAGES: Record<(typeof BOARD_KINDS)[number], Stage[]> = {
  creator: DEFAULT_CREATOR_STAGES,
  editor: [
    { id: 'to_pitch', name: 'To pitch' },
    { id: 'pitched', name: 'Pitched' },
    { id: 'replied', name: 'Replied' },
    { id: 'featured', name: 'Featured' },
    { id: 'passed', name: 'Passed' },
  ],
  playlist: [
    { id: 'to_pitch', name: 'To pitch' },
    { id: 'pitched', name: 'Pitched' },
    { id: 'added', name: 'Added' },
    { id: 'declined', name: 'Declined' },
  ],
  custom: [
    { id: 'todo', name: 'To do' },
    { id: 'doing', name: 'Doing' },
    { id: 'done', name: 'Done' },
  ],
};

const StageInput = z.object({ id: z.string().trim().min(1).max(40).regex(/^[a-z0-9_]+$/), name: z.string().trim().min(1).max(60) });

export const BoardInput = z.object({
  name: z.string().trim().min(1).max(200),
  kind: z.enum(BOARD_KINDS).default('creator'),
  campaignId: z.uuid().nullable().optional(),
  stages: z.array(StageInput).min(2).max(12).optional(),
});

export async function listBoards(ctx: ServiceContext) {
  ctx.assert('marketing:read');
  return ctx.tx
    .select({ board: boards, campaignName: campaigns.name, cardCount: sql<number>`(select count(*)::int from pipeline_cards c where c.board_id = "pipeline_boards"."id")` })
    .from(boards)
    .leftJoin(campaigns, eq(campaigns.id, boards.campaignId))
    .orderBy(sql`${campaigns.status} = 'active' desc nulls last`, desc(boards.updatedAt));
}

export async function createBoard(ctx: ServiceContext, input: z.input<typeof BoardInput>) {
  ctx.assert('marketing:write');
  const data = BoardInput.parse(input);
  const stages = data.stages ?? DEFAULT_STAGES[data.kind];
  if (new Set(stages.map((s) => s.id)).size !== stages.length) throw new ValidationError('Stage IDs must be unique');
  const [row] = await ctx.tx.insert(boards).values({ name: data.name, kind: data.kind, campaignId: data.campaignId ?? null, stages }).returning();
  await ctx.audit({ action: 'board.created', module: 'marketing', targetType: 'board', targetId: row.id, targetLabel: row.name });
  return row;
}

export async function updateBoard(ctx: ServiceContext, id: string, patch: { name?: string; stages?: Stage[] }) {
  ctx.assert('marketing:write');
  const board = await getBoardRow(ctx, id);
  const stages = patch.stages ? z.array(StageInput).min(2).max(12).parse(patch.stages) : undefined;
  if (stages) {
    // A stage with cards on it can't silently disappear.
    const used = await ctx.tx.selectDistinct({ stage: cards.stage }).from(cards).where(eq(cards.boardId, id));
    const missing = used.map((u) => u.stage).filter((s) => !stages.some((x) => x.id === s));
    if (missing.length) throw new ValidationError(`Move the cards out of ${missing.map((m) => board.stages.find((s) => s.id === m)?.name ?? m).join(', ')} first`);
  }
  const [row] = await ctx.tx.update(boards).set({ ...(patch.name ? { name: patch.name.trim() } : {}), ...(stages ? { stages } : {}) }).where(eq(boards.id, id)).returning();
  return row;
}

export async function deleteBoard(ctx: ServiceContext, id: string) {
  ctx.assert('marketing:delete');
  const board = await getBoardRow(ctx, id);
  const [paid] = await ctx.tx.select({ n: sql<number>`count(*)::int` }).from(cards).where(and(eq(cards.boardId, id), sql`coalesce(${cards.paidCents}, 0) > 0`));
  if ((paid?.n ?? 0) > 0) throw new ValidationError('This board has paid bookings, so it stays as the record of that spend.');
  await ctx.tx.delete(boards).where(eq(boards.id, id));
  await ctx.audit({ action: 'board.deleted', module: 'marketing', targetType: 'board', targetId: id, targetLabel: board.name });
}

export async function getBoardRow(ctx: ServiceContext, id: string) {
  ctx.assert('marketing:read');
  const [row] = await ctx.tx.select().from(boards).where(eq(boards.id, id));
  if (!row) throw new NotFoundError('Board');
  return row;
}

export async function getBoard(ctx: ServiceContext, id: string) {
  const board = await getBoardRow(ctx, id);
  const rows = await ctx.tx
    .select({ card: cards, contactName: contacts.name, contactGone: contacts.goneAt, contactVerified: contacts.verifiedAt })
    .from(cards)
    .leftJoin(contacts, eq(contacts.id, cards.contactId))
    .where(eq(cards.boardId, id))
    .orderBy(asc(cards.stage), asc(cards.position), asc(cards.createdAt));
  const campaign = board.campaignId ? (await ctx.tx.select({ id: campaigns.id, name: campaigns.name }).from(campaigns).where(eq(campaigns.id, board.campaignId)))[0] ?? null : null;
  return { board, campaign, cards: rows };
}

/** The campaign's creator board, created on first use. */
export async function creatorBoardFor(ctx: ServiceContext, campaignId: string) {
  const [existing] = await ctx.tx.select().from(boards).where(and(eq(boards.campaignId, campaignId), eq(boards.kind, 'creator'))).orderBy(asc(boards.createdAt)).limit(1);
  if (existing) return existing;
  const [c] = await ctx.tx.select({ name: campaigns.name }).from(campaigns).where(eq(campaigns.id, campaignId));
  if (!c) throw new NotFoundError('Campaign');
  const [row] = await ctx.tx.insert(boards).values({ name: `${c.name} · creators`, kind: 'creator', campaignId }).returning();
  return row;
}

/* -------------------------------------------------------------- cards --- */

const money = z.number().int().min(0).nullable();
export const CardInput = z.object({
  boardId: z.uuid(),
  stage: z.string().max(40).optional(),
  title: z.string().trim().min(1).max(300),
  contactId: z.uuid().nullable().optional(),
  campaignId: z.uuid().nullable().optional(),
  dueDate: z.iso.date().nullable().optional(),
  ownerId: z.uuid().nullable().optional(),
  offerCents: money.optional(),
  paidCents: money.optional(),
  paidAt: z.coerce.date().nullable().optional(),
  deliverablesOrdered: z.number().int().min(0).max(1000).default(0),
  deliverablesDelivered: z.number().int().min(0).max(1000).default(0),
  proofUrls: z.array(z.url()).max(50).default([]),
  measuredViews: z.number().int().min(0).nullable().optional(),
  notes: z.string().max(5000).nullable().optional(),
});
export const CardPatch = patchOf(CardInput.omit({ boardId: true }));

/** Money on a booking (offers and payments) needs the spend permission. */
function assertSpend(ctx: ServiceContext, data: { offerCents?: number | null; paidCents?: number | null; paidAt?: Date | null }) {
  if ((data.offerCents !== undefined || data.paidCents !== undefined || data.paidAt !== undefined) && !ctx.can('marketing:spend')) throw new ForbiddenError('Recording offers and payments needs the marketing spend permission');
}

export async function createCard(ctx: ServiceContext, input: z.input<typeof CardInput>) {
  ctx.assert('marketing:write');
  const data = CardInput.parse(input);
  assertSpend(ctx, data);
  const board = await getBoardRow(ctx, data.boardId);
  const stage = data.stage ?? board.stages[0].id;
  if (!board.stages.some((s) => s.id === stage)) throw new ValidationError(`"${stage}" is not a stage on this board`);
  if (data.contactId) await assertContactBookable(ctx, data.contactId);
  const [{ max }] = await ctx.tx.select({ max: sql<number>`coalesce(max(${cards.position}), -1)::int` }).from(cards).where(and(eq(cards.boardId, board.id), eq(cards.stage, stage)));
  const [row] = await ctx.tx
    .insert(cards)
    .values({ ...data, stage, position: max + 1, campaignId: data.campaignId ?? board.campaignId ?? null, paidAt: data.paidAt ?? (data.paidCents ? new Date() : null) })
    .returning();
  await ctx.audit({ action: 'card.created', module: 'marketing', targetType: 'card', targetId: row.id, targetLabel: row.title, after: { stage, offerCents: row.offerCents, paidCents: row.paidCents } });
  return row;
}

async function assertContactBookable(ctx: ServiceContext, contactId: string) {
  const [c] = await ctx.tx.select().from(contacts).where(eq(contacts.id, contactId));
  if (!c) throw new ValidationError('That contact does not exist', { fieldErrors: { contactId: ['Unknown contact'] } });
  if (c.goneAt) throw new ValidationError(`${c.name}'s account is gone; don't book them again`, { fieldErrors: { contactId: ['Account gone'] } });
  if (c.stage === 'do_not_contact') throw new ValidationError(`${c.name} asked not to be contacted`, { fieldErrors: { contactId: ['Do not contact'] } });
}

export async function getCardRow(ctx: ServiceContext, id: string) {
  ctx.assert('marketing:read');
  const [row] = await ctx.tx.select().from(cards).where(eq(cards.id, id));
  if (!row) throw new NotFoundError('Card');
  return row;
}

export async function updateCard(ctx: ServiceContext, id: string, patch: z.input<typeof CardPatch>) {
  ctx.assert('marketing:write');
  const before = await getCardRow(ctx, id);
  const data = CardPatch.parse(patch);
  assertSpend(ctx, data);
  if (data.contactId && data.contactId !== before.contactId) await assertContactBookable(ctx, data.contactId);
  if (data.stage && data.stage !== before.stage) await moveCard(ctx, id, { stage: data.stage, position: 0 });
  const { stage: _stage, ...rest } = data;
  const set: Record<string, unknown> = { ...rest };
  if (data.paidCents && !before.paidAt && data.paidAt === undefined) set.paidAt = new Date();
  if (Object.keys(set).length === 0) return getCardRow(ctx, id);
  const [after] = await ctx.tx.update(cards).set(set).where(eq(cards.id, id)).returning();
  const spendChanged = data.offerCents !== undefined || data.paidCents !== undefined;
  await ctx.audit({ action: spendChanged ? 'booking.spend_changed' : 'card.updated', module: 'marketing', targetType: 'card', targetId: id, targetLabel: after.title, before: before as never, after: after as never });
  return after;
}

export const MoveInput = z.object({ stage: z.string().min(1).max(40), position: z.number().int().min(0).default(0) });

export async function moveCard(ctx: ServiceContext, id: string, input: z.input<typeof MoveInput>) {
  ctx.assert('marketing:write');
  const { stage, position } = MoveInput.parse(input);
  const card = await getCardRow(ctx, id);
  const board = await getBoardRow(ctx, card.boardId);
  if (!board.stages.some((s) => s.id === stage)) throw new ValidationError(`"${stage}" is not a stage on this board`);
  // Make room at the target position, then place the card.
  await ctx.tx.update(cards).set({ position: sql`${cards.position} + 1` }).where(and(eq(cards.boardId, board.id), eq(cards.stage, stage), gte(cards.position, position), sql`${cards.id} <> ${id}`));
  const [after] = await ctx.tx.update(cards).set({ stage, position }).where(eq(cards.id, id)).returning();
  if (card.stage !== stage) {
    await ctx.audit({ action: 'card.moved', module: 'marketing', targetType: 'card', targetId: id, targetLabel: card.title, before: { stage: card.stage }, after: { stage } });
    await ctx.emit('marketing.card.moved', { cardId: id, boardId: board.id, from: card.stage, to: stage });
  }
  return after;
}

export async function deleteCard(ctx: ServiceContext, id: string) {
  ctx.assert('marketing:write');
  const card = await getCardRow(ctx, id);
  if ((card.paidCents ?? 0) > 0) throw new ValidationError('This booking has been paid, so it stays on record. Move it or edit it instead.');
  await ctx.tx.delete(cards).where(eq(cards.id, id));
  await ctx.audit({ action: 'card.deleted', module: 'marketing', targetType: 'card', targetId: id, targetLabel: card.title });
}

/** A contact's bookings across every board (contact page panel). */
export async function cardsForContact(ctx: ServiceContext, contactId: string) {
  ctx.assert('marketing:read');
  return ctx.tx
    .select({ card: cards, boardName: boards.name, boardKind: boards.kind, stages: boards.stages, campaignName: campaigns.name })
    .from(cards)
    .innerJoin(boards, eq(boards.id, cards.boardId))
    .leftJoin(campaigns, eq(campaigns.id, sql`coalesce(${cards.campaignId}, ${boards.campaignId})`))
    .where(eq(cards.contactId, contactId))
    .orderBy(desc(cards.updatedAt));
}
