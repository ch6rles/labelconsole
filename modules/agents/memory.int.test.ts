import { eq } from 'drizzle-orm';
import { afterAll, afterEach, describe, expect, it } from 'vitest';
import '../../test/modules';
import { closeDb, systemDb } from '@labelconsole/core/db/client';
import { EMBEDDING_DIMENSIONS, embeddingModel, setEmbeddingProviderFactory, type EmbeddingProvider } from '@labelconsole/core/embeddings';
import { closeQueues } from '@labelconsole/core/queue';
import { closeRedis } from '@labelconsole/core/redis';
import { makeOrg, runJob, type TestOrg } from '../../test/helpers';
import { jobs } from './jobs';
import { memories } from './schema';
import * as svc from './service';

/*
 * A deterministic embedder for tests only (production uses Voyage AI). Words in
 * the same concept group share a dimension, so related texts land close together
 * even when they share no words, which is exactly what full-text search misses.
 */
const CONCEPTS: string[][] = [
  ['send', 'submit', 'submissions', 'submission', 'email', 'pitch', 'pitches'],
  ['music', 'song', 'track', 'single'],
  ['streams', 'plays', 'views', 'listens'],
];
class ConceptEmbedder implements EmbeddingProvider {
  readonly id = 'test';
  calls = 0;
  constructor(readonly model = embeddingModel(), private readonly fail = false) {}
  async embed(texts: string[]) {
    this.calls++;
    if (this.fail) throw new Error('embedding service unavailable');
    const vectors = texts.map((t) => {
      const v = new Array<number>(EMBEDDING_DIMENSIONS).fill(0);
      for (const w of t.toLowerCase().match(/[a-z]+/g) ?? []) {
        const c = CONCEPTS.findIndex((g) => g.includes(w));
        if (c >= 0) v[c] += 3; // concepts dominate
        else v[100 + ([...w].reduce((h, ch) => (h * 31 + ch.charCodeAt(0)) >>> 0, 7) % 900)] += 1;
      }
      const norm = Math.hypot(...v) || 1;
      return v.map((x) => x / norm);
    });
    return { vectors, tokens: texts.join(' ').length };
  }
}

const useEmbedder = (e: EmbeddingProvider | null) => setEmbeddingProviderFactory(async () => e);
const embedJob = (a: TestOrg) => runJob(jobs, 'agents.embed-memories', a.org.id, {});
const rowsOf = (a: TestOrg) => systemDb().select({ id: memories.id, content: memories.content, model: memories.embeddingModel, hasVector: memories.embedding }).from(memories).where(eq(memories.orgId, a.org.id));

afterEach(() => setEmbeddingProviderFactory(null));
afterAll(async () => {
  await closeQueues();
  await closeDb();
  await closeRedis();
});

async function agentFor(a: TestOrg) {
  return a.as((ctx) => svc.createAgentFromType(ctx, 'playlist-outreach'));
}

describe('semantic agent memory', () => {
  it('embeds memories in the background and recalls by meaning, not only by words', async () => {
    const a = await makeOrg('Memory Label');
    const agent = await agentFor(a);
    await a.as((ctx) => svc.remember(ctx, agent.id, { content: 'Quiet Indie only takes submissions by email', kind: 'fact', importance: 0.3 }));
    await a.as((ctx) => svc.remember(ctx, agent.id, { content: 'Night Ferries does about four thousand a day on YouTube', kind: 'fact', importance: 0.9 }));
    const query = 'how do we send our music to that playlist';

    // Without embeddings: no shared words, so importance decides and the wrong memory comes first.
    useEmbedder(null);
    expect((await a.as((ctx) => svc.recall(ctx, agent.id, query, 2)))[0].content).toMatch(/Night Ferries/);

    const embedder = new ConceptEmbedder();
    useEmbedder(embedder);
    expect(await embedJob(a)).toMatchObject({ embedded: 2 });
    const rows = await rowsOf(a);
    expect(rows.every((r) => r.model === embedder.model && r.hasVector)).toBe(true);
    expect(await a.as(svc.memoryStats)).toMatchObject({ configured: true, total: 2, embedded: 2 });

    // With embeddings the submission rule wins, despite lower importance.
    expect((await a.as((ctx) => svc.recall(ctx, agent.id, query, 2)))[0].content).toMatch(/Quiet Indie/);
    // Nothing left to embed.
    expect(await embedJob(a)).toMatchObject({ embedded: 0 });
  });

  it('re-embeds corrected memories and everything after a model change', async () => {
    const a = await makeOrg('Reembed Label');
    const agent = await agentFor(a);
    useEmbedder(new ConceptEmbedder());
    const m = await a.as((ctx) => svc.remember(ctx, agent.id, { content: 'Pitch editors on Tuesdays', kind: 'preference' }));
    await a.as((ctx) => svc.remember(ctx, null, { content: 'Never pay for playlist placement', kind: 'preference', scope: 'org' }));
    await embedJob(a);

    // A correction drops the old vector until the job re-embeds it.
    await a.as((ctx) => svc.updateMemory(ctx, m.id, { content: 'Pitch editors on Wednesdays' }));
    expect((await rowsOf(a)).find((r) => r.id === m.id)?.model).toBeNull();
    // Changing only importance keeps the vector.
    await embedJob(a);
    await a.as((ctx) => svc.updateMemory(ctx, m.id, { importance: 0.9 }));
    expect((await rowsOf(a)).find((r) => r.id === m.id)?.model).not.toBeNull();

    // A new model: every memory is re-embedded with it.
    useEmbedder(new ConceptEmbedder('test-model-v2'));
    expect(await embedJob(a)).toMatchObject({ embedded: 2, model: 'test-model-v2' });
    expect((await rowsOf(a)).every((r) => r.model === 'test-model-v2')).toBe(true);
  });

  it('keeps recall working when the embedding service fails, and never overwrites a newer edit', async () => {
    const a = await makeOrg('Fallback Label');
    const agent = await agentFor(a);
    await a.as((ctx) => svc.remember(ctx, agent.id, { content: 'Lena at Quiet Indie prefers short pitches', kind: 'fact' }));
    useEmbedder(new ConceptEmbedder(embeddingModel(), true));
    const found = await a.as((ctx) => svc.recall(ctx, agent.id, 'Lena pitches', 5));
    expect(found.map((f) => f.content)).toEqual(['Lena at Quiet Indie prefers short pitches']);
    await expect(embedJob(a)).rejects.toThrow(/unavailable/);

    // An embedding computed from old text is discarded if the memory changed meanwhile.
    useEmbedder(new ConceptEmbedder());
    const [row] = await a.as((ctx) => svc.pendingEmbeddings(ctx, embeddingModel()));
    await a.as((ctx) => svc.updateMemory(ctx, row.id, { content: 'Lena prefers pitches under 100 words' }));
    const { vectors } = await new ConceptEmbedder().embed([row.content]);
    await a.as((ctx) => svc.saveEmbeddings(ctx, embeddingModel(), [{ id: row.id, content: row.content, vector: vectors[0] }], 0));
    expect((await rowsOf(a))[0].model).toBeNull();
  });

  it('never returns vectors from reads, and says when semantic recall is off', async () => {
    const a = await makeOrg('Lean Label');
    const agent = await agentFor(a);
    useEmbedder(new ConceptEmbedder());
    await a.as((ctx) => svc.remember(ctx, agent.id, { content: 'Release Fridays at midnight', kind: 'fact' }));
    await embedJob(a);
    const listed = await a.as((ctx) => svc.listMemories(ctx, {}));
    expect(listed[0]).not.toHaveProperty('embedding');
    const recalled = await a.as((ctx) => svc.recall(ctx, agent.id, 'release', 1));
    expect(recalled[0]).not.toHaveProperty('embedding');
    useEmbedder(null);
    expect((await a.as(svc.memoryStats)).configured).toBe(false);
  });
});
