import { and, desc, eq, getTableColumns, inArray, isNull, or, sql } from 'drizzle-orm';
import { z } from 'zod';
import type { ServiceContext } from '@labelconsole/core/context';
import { embeddingModel, embeddingProviderFor, embeddingsConfigured, toVectorLiteral, type EmbeddingProvider } from '@labelconsole/core/embeddings';
import { NotFoundError } from '@labelconsole/core/errors';
import { logger } from '@labelconsole/core/logger';
import { enqueueAfterCommit } from '@labelconsole/core/queue';
import { recordUsage } from '@labelconsole/core/usage';
import { MEMORY_KINDS, memories } from '../schema';

/**
 * Long-term memory: facts, outcomes and preferences an agent (or staff) wants
 * kept across runs. Recall is hybrid: semantic similarity from embeddings
 * (Voyage AI) plus Postgres full-text rank, then importance and recency.
 * Memories are embedded in the background after every write; without an
 * embedding key, or for memories not embedded yet, full-text search carries
 * recall on its own.
 */
export const MemoryInput = z.object({
  content: z.string().trim().min(3).max(2000),
  kind: z.enum(MEMORY_KINDS).default('fact'),
  importance: z.number().min(0).max(1).default(0.5),
  scope: z.enum(['agent', 'org']).default('agent'),
  expiresAt: z.coerce.date().nullable().optional(),
});

/** Cosine similarity below this is noise for Voyage embeddings; SPAN maps the useful range onto about 0–1. */
const SIMILARITY_FLOOR = 0.2;
const SIMILARITY_SPAN = 0.5;

/** Every column except the vector and the tsvector: reads never need to ship 1024 floats per row. */
const { embedding: _embedding, tsv: _tsv, ...memoryColumns } = getTableColumns(memories);

/** Embed this label's new or changed memories shortly after commit (bursts share one job). */
function queueEmbedding(ctx: ServiceContext) {
  const bucket = Math.floor(Date.now() / 30_000);
  enqueueAfterCommit(ctx, 'agents.embed-memories', {}, { jobId: `embed-${ctx.orgId}-${bucket}`, delay: 2_000, attempts: 3 });
}

export async function remember(ctx: ServiceContext, agentId: string | null, input: z.input<typeof MemoryInput>, sourceRunId?: string) {
  const data = MemoryInput.parse(input);
  // Don't store the same thing twice; bump its importance instead.
  const [dupe] = await ctx.tx
    .select(memoryColumns)
    .from(memories)
    .where(and(sql`lower(${memories.content}) = lower(${data.content})`, data.scope === 'org' ? isNull(memories.agentId) : agentId ? eq(memories.agentId, agentId) : isNull(memories.agentId)));
  if (dupe) {
    const [row] = await ctx.tx.update(memories).set({ importance: Math.max(dupe.importance, data.importance), lastUsedAt: new Date() }).where(eq(memories.id, dupe.id)).returning(memoryColumns);
    if (!dupe.embeddingModel) queueEmbedding(ctx);
    return row;
  }
  const [row] = await ctx.tx
    .insert(memories)
    .values({ agentId: data.scope === 'org' ? null : agentId, scope: data.scope, kind: data.kind, content: data.content, importance: data.importance, sourceRunId: sourceRunId ?? null, expiresAt: data.expiresAt ?? null })
    .returning(memoryColumns);
  queueEmbedding(ctx);
  return row;
}

/** The query's embedding for recall, or null (no key, or the provider failed: recall falls back to text). */
async function queryVector(ctx: ServiceContext, query: string): Promise<{ vector: string; model: string } | null> {
  if (!query) return null;
  let provider: EmbeddingProvider | null;
  try {
    provider = await embeddingProviderFor(ctx);
    if (!provider) return null;
    const { vectors, tokens } = await provider.embed([query], 'query');
    if (tokens) await recordUsage(ctx, 'embedding_tokens', tokens);
    return { vector: toVectorLiteral(vectors[0]), model: provider.model };
  } catch (err) {
    logger.warn({ err: (err as Error).message, orgId: ctx.orgId }, 'embedding the recall query failed; using full-text recall');
    return null;
  }
}

/** Memories relevant to a query for one agent: its own plus org-wide ones. */
export async function recall(ctx: ServiceContext, agentId: string, query: string, limit = 8) {
  const live = and(or(eq(memories.agentId, agentId), isNull(memories.agentId)), or(isNull(memories.expiresAt), sql`${memories.expiresAt} > now()`));
  const q = query.trim().slice(0, 2000);
  const rank = q ? sql<number>`ts_rank(${memories.tsv}, websearch_to_tsquery('english', ${q.slice(0, 500)}))` : sql<number>`0`;
  const qv = await queryVector(ctx, q);
  // Relevance from cosine similarity (Voyage vectors are unit length), only against vectors from the same model.
  // Unrelated texts still score about 0.15–0.3 and related ones 0.4–0.75, so similarity is measured above
  // that floor and scaled: a clearly relevant memory then outranks an unrelated one of any importance.
  const semantic = qv
    ? sql<number>`case when ${memories.embedding} is not null and ${memories.embeddingModel} = ${qv.model} then greatest(0, 1 - (${memories.embedding} <=> ${qv.vector}::vector) - ${SIMILARITY_FLOOR}) / ${SIMILARITY_SPAN} else 0 end`
    : sql<number>`0`;
  const rows = await ctx.tx
    .select({ memory: memoryColumns, rank, semantic })
    .from(memories)
    .where(live)
    // Relevance (meaning, then words) first, then importance, then freshness.
    .orderBy(desc(sql`${semantic} * 6 + ${rank} * 4 + ${memories.importance} + case when ${memories.lastUsedAt} > now() - interval '30 days' then 0.2 else 0 end`), desc(memories.createdAt))
    .limit(limit);
  if (rows.length) await ctx.tx.update(memories).set({ lastUsedAt: new Date() }).where(inArray(memories.id, rows.map((r) => r.memory.id)));
  return rows.map((r) => r.memory);
}

/** Memories with no embedding yet, or one from a different model (most important first). */
export async function pendingEmbeddings(ctx: ServiceContext, model: string, batch = 128) {
  return ctx.tx
    .select({ id: memories.id, content: memories.content })
    .from(memories)
    .where(and(sql`(${memories.embedding} is null or ${memories.embeddingModel} is distinct from ${model})`, or(isNull(memories.expiresAt), sql`${memories.expiresAt} > now()`)))
    .orderBy(desc(memories.importance), memories.createdAt)
    .limit(batch);
}

/**
 * Store embeddings made outside the transaction. A memory corrected in the
 * meantime keeps its null embedding (the content check), and gets picked up again.
 */
export async function saveEmbeddings(ctx: ServiceContext, model: string, items: Array<{ id: string; content: string; vector: number[] }>, tokens: number) {
  for (const it of items) {
    await ctx.tx.update(memories).set({ embedding: it.vector, embeddingModel: model }).where(and(eq(memories.id, it.id), eq(memories.content, it.content)));
  }
  if (tokens) await recordUsage(ctx, 'embedding_tokens', tokens);
}

/** For the Memory page: is semantic recall on, and how much is embedded with the current model. */
export async function memoryStats(ctx: ServiceContext) {
  ctx.assert('agents:read');
  const model = embeddingModel();
  const [row] = await ctx.tx
    .select({ total: sql<number>`count(*)::int`, embedded: sql<number>`count(*) filter (where ${memories.embedding} is not null and ${memories.embeddingModel} = ${model})::int` })
    .from(memories);
  return { configured: await embeddingsConfigured(ctx), model, total: row?.total ?? 0, embedded: row?.embedded ?? 0 };
}

export async function listMemories(ctx: ServiceContext, q: { agentId?: string; search?: string } = {}) {
  ctx.assert('agents:read');
  const conds = [];
  if (q.agentId === 'org') conds.push(isNull(memories.agentId));
  else if (q.agentId) conds.push(eq(memories.agentId, q.agentId));
  if (q.search) conds.push(sql`${memories.tsv} @@ websearch_to_tsquery('english', ${q.search})`);
  return ctx.tx.select(memoryColumns).from(memories).where(conds.length ? and(...conds) : undefined).orderBy(desc(memories.importance), desc(memories.createdAt)).limit(500);
}

export const MemoryPatch = z.object({ content: z.string().trim().min(3).max(2000), importance: z.number().min(0).max(1), kind: z.enum(MEMORY_KINDS) }).partial();

/** Staff can correct or delete what agents remember. A corrected memory is re-embedded. */
export async function updateMemory(ctx: ServiceContext, id: string, patch: z.input<typeof MemoryPatch>) {
  ctx.assert('agents:manage');
  const data = MemoryPatch.parse(patch);
  const [before] = await ctx.tx.select({ content: memories.content }).from(memories).where(eq(memories.id, id));
  if (!before) throw new NotFoundError('Memory');
  const contentChanged = data.content !== undefined && data.content !== before.content;
  const [row] = await ctx.tx
    .update(memories)
    .set({ ...data, ...(contentChanged ? { embedding: null, embeddingModel: null } : {}) })
    .where(eq(memories.id, id))
    .returning(memoryColumns);
  if (contentChanged) queueEmbedding(ctx);
  await ctx.audit({ action: 'memory.corrected', module: 'agents', targetType: 'memory', targetId: id });
  return row;
}

export async function deleteMemory(ctx: ServiceContext, id: string) {
  ctx.assert('agents:manage');
  await ctx.tx.delete(memories).where(eq(memories.id, id));
  await ctx.audit({ action: 'memory.deleted', module: 'agents', targetType: 'memory', targetId: id });
}
