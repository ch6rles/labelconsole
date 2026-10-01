import { and, desc, eq, inArray, isNull, or, sql } from 'drizzle-orm';
import { z } from 'zod';
import type { ServiceContext } from '@labelconsole/core/context';
import { NotFoundError } from '@labelconsole/core/errors';
import { MEMORY_KINDS, memories } from '../schema';

/**
 * Long-term memory: facts, outcomes and preferences an agent (or staff) wants
 * kept across runs. Retrieval is Postgres full-text search weighted by
 * importance and recency. The pgvector column is ready for embeddings once an
 * embedding provider is chosen; until then it stays empty rather than faked.
 */
export const MemoryInput = z.object({
  content: z.string().trim().min(3).max(2000),
  kind: z.enum(MEMORY_KINDS).default('fact'),
  importance: z.number().min(0).max(1).default(0.5),
  scope: z.enum(['agent', 'org']).default('agent'),
  expiresAt: z.coerce.date().nullable().optional(),
});

export async function remember(ctx: ServiceContext, agentId: string | null, input: z.input<typeof MemoryInput>, sourceRunId?: string) {
  const data = MemoryInput.parse(input);
  // Don't store the same thing twice; bump its importance instead.
  const [dupe] = await ctx.tx
    .select()
    .from(memories)
    .where(and(sql`lower(${memories.content}) = lower(${data.content})`, data.scope === 'org' ? isNull(memories.agentId) : agentId ? eq(memories.agentId, agentId) : isNull(memories.agentId)));
  if (dupe) {
    const [row] = await ctx.tx.update(memories).set({ importance: Math.max(dupe.importance, data.importance), lastUsedAt: new Date() }).where(eq(memories.id, dupe.id)).returning();
    return row;
  }
  const [row] = await ctx.tx
    .insert(memories)
    .values({ agentId: data.scope === 'org' ? null : agentId, scope: data.scope, kind: data.kind, content: data.content, importance: data.importance, sourceRunId: sourceRunId ?? null, expiresAt: data.expiresAt ?? null })
    .returning();
  return row;
}

/** Memories relevant to a query for one agent: its own plus org-wide ones. */
export async function recall(ctx: ServiceContext, agentId: string, query: string, limit = 8) {
  const live = and(or(eq(memories.agentId, agentId), isNull(memories.agentId)), or(isNull(memories.expiresAt), sql`${memories.expiresAt} > now()`));
  const q = query.trim().slice(0, 500);
  const rank = q ? sql<number>`ts_rank(${memories.tsv}, websearch_to_tsquery('english', ${q}))` : sql<number>`0`;
  const rows = await ctx.tx
    .select({ memory: memories, rank })
    .from(memories)
    .where(live)
    // Relevance first, then importance, then freshness.
    .orderBy(desc(sql`${rank} * 4 + ${memories.importance} + case when ${memories.lastUsedAt} > now() - interval '30 days' then 0.2 else 0 end`), desc(memories.createdAt))
    .limit(limit);
  if (rows.length) await ctx.tx.update(memories).set({ lastUsedAt: new Date() }).where(inArray(memories.id, rows.map((r) => r.memory.id)));
  return rows.map((r) => r.memory);
}

export async function listMemories(ctx: ServiceContext, q: { agentId?: string; search?: string } = {}) {
  ctx.assert('agents:read');
  const conds = [];
  if (q.agentId === 'org') conds.push(isNull(memories.agentId));
  else if (q.agentId) conds.push(eq(memories.agentId, q.agentId));
  if (q.search) conds.push(sql`${memories.tsv} @@ websearch_to_tsquery('english', ${q.search})`);
  return ctx.tx.select().from(memories).where(conds.length ? and(...conds) : undefined).orderBy(desc(memories.importance), desc(memories.createdAt)).limit(500);
}

export const MemoryPatch = z.object({ content: z.string().trim().min(3).max(2000), importance: z.number().min(0).max(1), kind: z.enum(MEMORY_KINDS) }).partial();

/** Staff can correct or delete what agents remember. */
export async function updateMemory(ctx: ServiceContext, id: string, patch: z.input<typeof MemoryPatch>) {
  ctx.assert('agents:manage');
  const [row] = await ctx.tx.update(memories).set(MemoryPatch.parse(patch)).where(eq(memories.id, id)).returning();
  if (!row) throw new NotFoundError('Memory');
  await ctx.audit({ action: 'memory.corrected', module: 'agents', targetType: 'memory', targetId: id });
  return row;
}

export async function deleteMemory(ctx: ServiceContext, id: string) {
  ctx.assert('agents:manage');
  await ctx.tx.delete(memories).where(eq(memories.id, id));
  await ctx.audit({ action: 'memory.deleted', module: 'agents', targetType: 'memory', targetId: id });
}
