/**
 * Load test: many labels running many agents at once through the real worker
 * (BullMQ, Postgres, Redis, the real runtime and tools). Only the model is a
 * stub, with realistic latency, because this measures the platform, not Claude.
 *
 *   pnpm test:load                       # 12 labels × 4 agents × 2 runs
 *   LOAD_ORGS=40 LOAD_AGENTS=5 pnpm test:load
 *
 * It checks that every run finishes, that no label ever exceeds its
 * concurrency limit, that nothing runs twice (model calls, tool side effects),
 * and that ordinary reads stay fast while agents are busy. A summary is
 * written to test-results/load-agents.json.
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { and, eq, inArray, sql } from 'drizzle-orm';
import { afterAll, describe, expect, it } from 'vitest';
import '../modules';
import { allModules } from '../modules';
import { closeDb, systemDb } from '@labelconsole/core/db/client';
import { env } from '@labelconsole/core/env';
import type { LlmContentBlock, LlmProvider, LlmRequest } from '@labelconsole/core/llm';
import { closeQueues } from '@labelconsole/core/queue';
import { closeRedis } from '@labelconsole/core/redis';
import { setLlmProviderFactory } from '@labelconsole/core/usage';
import { startWorker, type WorkerRuntime } from '@labelconsole/core/worker';
import { createRelease, listReleases } from '@labelconsole/catalogue/service';
import { memories, runs, steps } from '@labelconsole/agents/schema';
import * as agentsSvc from '@labelconsole/agents/service';
import { makeOrg, type TestOrg } from '../helpers';

const ORGS = Number(process.env.LOAD_ORGS ?? 12);
const AGENTS = Number(process.env.LOAD_AGENTS ?? 4);
const RUNS_PER_AGENT = Number(process.env.LOAD_RUNS_PER_AGENT ?? 2);
const MODEL_LATENCY_MS: [number, number] = [60, 180];
const AGENT_WORKER_CONCURRENCY = Number(process.env.LOAD_WORKER_CONCURRENCY ?? 32);
const TIMEOUT_MS = Number(process.env.LOAD_TIMEOUT_MS ?? 240_000);

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const say = (text: string) => ({ type: 'text', text, citations: null }) as unknown as LlmContentBlock;
const call = (id: string, name: string, input: unknown) => ({ type: 'tool_use', id, name, input }) as unknown as LlmContentBlock;

/** Scripted model (tests only): search the catalogue, remember one fact, answer. */
class LatencyStub implements LlmProvider {
  readonly id = 'load-stub';
  calls = 0;
  async chat(req: LlmRequest) {
    this.calls++;
    await sleep(MODEL_LATENCY_MS[0] + Math.random() * (MODEL_LATENCY_MS[1] - MODEL_LATENCY_MS[0]));
    const turn = req.messages.filter((m) => m.role === 'assistant').length + 1;
    const task = JSON.stringify(req.messages[0]).match(/load task ([\w-]+)/)?.[1] ?? 'unknown';
    const content =
      turn === 1
        ? [say('Checking the catalogue.'), call('tu_1', 'catalogue_search', { q: 'Load' })]
        : turn === 2
          ? [call('tu_2', 'agents_remember', { content: `load fact for ${task}`, kind: 'fact', importance: 0.5 })]
          : [say(`Done with ${task}.`)];
    return { id: `msg_${this.calls}`, model: req.model, content, stopReason: content.some((b) => (b as { type: string }).type === 'tool_use') ? 'tool_use' : 'end_turn', usage: { inputTokens: 3_000, outputTokens: 250, cacheReadTokens: 0, cacheWriteTokens: 0, webSearchRequests: 0 }, stopDetails: null } as Awaited<ReturnType<LlmProvider['chat']>>;
  }
  async extract(): Promise<never> {
    throw new Error('not used');
  }
}

const pct = (values: number[], p: number) => {
  const s = [...values].sort((a, b) => a - b);
  return s.length ? s[Math.min(s.length - 1, Math.floor((p / 100) * s.length))] : 0;
};

let worker: WorkerRuntime | undefined;
afterAll(async () => {
  setLlmProviderFactory(null);
  await worker?.stop();
  await closeQueues();
  await closeDb();
  await closeRedis();
});

describe('agent load', () => {
  it(`runs ${ORGS * AGENTS * RUNS_PER_AGENT} agent runs across ${ORGS} labels without overlap, repeats or starving reads`, async () => {
    const stub = new LatencyStub();
    setLlmProviderFactory(async () => stub);
    const limit = env().AGENT_CONCURRENCY_PER_ORG;

    // Labels, each with a little catalogue and a few agents.
    const orgs: TestOrg[] = [];
    const agentIds: string[] = [];
    for (let i = 0; i < ORGS; i++) {
      const o = await makeOrg(`Load Label ${i}`);
      await o.as(async (ctx) => {
        for (let r = 0; r < 5; r++) await createRelease(ctx, { title: `Load Release ${r}` });
      });
      for (let j = 0; j < AGENTS; j++) {
        const agent = await o.as((ctx) =>
          agentsSvc.createAgent(ctx, {
            type: 'stream-watch',
            name: `Load agent ${j}`,
            goal: 'Exercise the platform',
            model: 'claude-opus-5-5',
            toolAllowlist: ['catalogue_search', 'agents_remember'],
            role: 'manager',
            approvalPolicy: { risk: { read: 'auto', write: 'auto', external: 'approve', destructive: 'approve', spend: 'approve' } },
            budget: { perRunUsd: 5, perDayUsd: 500 },
          }),
        );
        agentIds.push(agent.id);
      }
      orgs.push(o);
    }

    worker = await startWorker({ modules: allModules, concurrency: { agents: AGENT_WORKER_CONCURRENCY }, schedules: false, healthPort: null, outboxPollMs: 250 });

    // Start everything at once.
    const started = Date.now();
    const runIds: string[] = [];
    await Promise.all(
      orgs.map(async (o) => {
        const mine = await o.as((ctx) => agentsSvc.listAgents(ctx));
        for (const a of mine)
          for (let k = 0; k < RUNS_PER_AGENT; k++) {
            const run = await o.as((ctx) => agentsSvc.startRun(ctx, { agentId: a.id, triggerKind: 'manual', task: `load task ${a.id.slice(0, 8)}-${k}` }));
            runIds.push(run.id);
          }
      }),
    );

    // While it runs: sample per-label concurrency, and time ordinary reads.
    let maxRunningPerOrg = 0;
    let maxRunningTotal = 0;
    const readMs: number[] = [];
    let done = false;
    const sampler = (async () => {
      let n = 0;
      while (!done) {
        const rows = (await systemDb().execute(sql`select org_id, count(*)::int as n from agent_runs where status = 'running' group by org_id`)) as unknown as Array<{ n: number }>;
        maxRunningPerOrg = Math.max(maxRunningPerOrg, ...rows.map((r) => r.n), 0);
        maxRunningTotal = Math.max(maxRunningTotal, rows.reduce((a, r) => a + r.n, 0));
        const o = orgs[n++ % orgs.length];
        const t = performance.now();
        await o.as((ctx) => listReleases(ctx, {}));
        readMs.push(performance.now() - t);
        await sleep(40);
      }
    })();

    let statuses: Array<{ status: string; n: number }> = [];
    while (Date.now() - started < TIMEOUT_MS) {
      statuses = (await systemDb().execute(sql`select status, count(*)::int as n from agent_runs where id in ${sql.raw(`('${runIds.join("','")}')`)} group by status`)) as unknown as typeof statuses;
      const open = statuses.filter((s) => !['completed', 'failed', 'stopped', 'budget_exceeded'].includes(s.status)).reduce((a, s) => a + s.n, 0);
      if (open === 0) break;
      await sleep(500);
    }
    done = true;
    await sampler;
    const elapsed = (Date.now() - started) / 1000;

    const finished = await systemDb().select({ id: runs.id, status: runs.status, startedAt: runs.startedAt, endedAt: runs.endedAt, createdAt: runs.createdAt, stepCount: runs.stepCount }).from(runs).where(inArray(runs.id, runIds));
    const toolCalls = (await systemDb().execute(sql`select run_id, tool_name, count(*)::int as n from agent_steps where kind = 'tool_call' and run_id in ${sql.raw(`('${runIds.join("','")}')`)} group by run_id, tool_name`)) as unknown as Array<{ run_id: string; tool_name: string; n: number }>;
    const facts = await systemDb().select({ agentId: memories.agentId, n: sql<number>`count(*)::int` }).from(memories).where(and(inArray(memories.agentId, agentIds), eq(memories.kind, 'fact'))).groupBy(memories.agentId);
    const queueWait = finished.filter((r) => r.startedAt).map((r) => r.startedAt!.getTime() - r.createdAt.getTime());
    const runTime = finished.filter((r) => r.startedAt && r.endedAt).map((r) => r.endedAt!.getTime() - r.startedAt!.getTime());

    const summary = {
      at: new Date().toISOString(),
      labels: ORGS,
      agents: ORGS * AGENTS,
      runs: runIds.length,
      perLabelLimit: limit,
      workerAgentConcurrency: AGENT_WORKER_CONCURRENCY,
      modelLatencyMs: MODEL_LATENCY_MS,
      elapsedSec: Number(elapsed.toFixed(1)),
      runsPerMinute: Number(((runIds.length / elapsed) * 60).toFixed(1)),
      statuses: Object.fromEntries(statuses.map((s) => [s.status, s.n])),
      maxRunningPerLabel: maxRunningPerOrg,
      maxRunningTotal,
      modelCalls: stub.calls,
      queueWaitMs: { p50: pct(queueWait, 50), p95: pct(queueWait, 95), max: Math.max(0, ...queueWait) },
      runMs: { p50: pct(runTime, 50), p95: pct(runTime, 95), max: Math.max(0, ...runTime) },
      readsDuringLoad: { samples: readMs.length, p50: Number(pct(readMs, 50).toFixed(1)), p95: Number(pct(readMs, 95).toFixed(1)), max: Number(Math.max(0, ...readMs).toFixed(1)) },
    };
    mkdirSync('test-results', { recursive: true });
    writeFileSync('test-results/load-agents.json', JSON.stringify(summary, null, 2) + '\n');
    console.log(JSON.stringify(summary, null, 2));

    // Every run finished, successfully.
    expect(finished.every((r) => r.status === 'completed')).toBe(true);
    // No label ever had more runs going than its limit.
    expect(maxRunningPerOrg).toBeLessThanOrEqual(limit);
    // Nothing ran twice: three model calls and exactly one of each tool per run, one remembered fact per run.
    expect(stub.calls).toBe(runIds.length * 3);
    expect(toolCalls.every((t) => t.n === 1)).toBe(true);
    expect(toolCalls.length).toBe(runIds.length * 2);
    expect(facts.reduce((a, f) => a + f.n, 0)).toBe(runIds.length);
    expect(finished.every((r) => r.stepCount === 3)).toBe(true);
    // Reads stay usable while the agents work.
    expect(summary.readsDuringLoad.p95).toBeLessThan(500);
    void steps;
  }, TIMEOUT_MS + 120_000);
});
