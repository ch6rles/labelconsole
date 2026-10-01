import { and, eq } from 'drizzle-orm';
import { afterAll, afterEach, describe, expect, it } from 'vitest';
import '../../test/modules';
import { allModules } from '../../test/modules';
import { withSystemOrg } from '@labelconsole/core/context';
import { closeDb, systemDb } from '@labelconsole/core/db/client';
import { domainEvents, idempotencyKeys, memberships, users } from '@labelconsole/core/db/schema';
import { ConflictError, ProviderError, ValidationError } from '@labelconsole/core/errors';
import type { LlmContentBlock, LlmProvider, LlmRequest } from '@labelconsole/core/llm';
import { closeQueues } from '@labelconsole/core/queue';
import { closeRedis } from '@labelconsole/core/redis';
import { setLlmProviderFactory } from '@labelconsole/core/usage';
import { createArtist, getArtist } from '@labelconsole/people/service';
import { releases } from '@labelconsole/catalogue/schema';
import { makeOrg, runJob, type TestOrg } from '../../test/helpers';
import { jobs } from './jobs';
import { agents, approvals, memories, runs, steps, triggers } from './schema';
import * as svc from './service';

afterAll(async () => {
  setLlmProviderFactory(null);
  await closeQueues();
  await closeDb();
  await closeRedis();
});
afterEach(() => setLlmProviderFactory(null));

/* A scripted model for tests only: production always talks to Claude. */
type Reply = LlmContentBlock[] | Error;
class StubProvider implements LlmProvider {
  readonly id = 'stub';
  calls: LlmRequest[] = [];
  constructor(
    private script: (req: LlmRequest, n: number) => Reply,
    private usage = { inputTokens: 2_000, outputTokens: 300, cacheReadTokens: 0, cacheWriteTokens: 0, webSearchRequests: 0 },
  ) {}
  async chat(req: LlmRequest) {
    this.calls.push(JSON.parse(JSON.stringify({ ...req, signal: undefined })));
    const out = this.script(req, this.calls.length);
    if (out instanceof Error) throw out;
    return { id: `msg_${this.calls.length}`, model: req.model, content: out, stopReason: out.some((b) => b.type === 'tool_use') ? 'tool_use' : 'end_turn', usage: this.usage, stopDetails: null };
  }
  async extract(): Promise<never> {
    throw new Error('not used');
  }
}
const say = (text: string) => ({ type: 'text', text, citations: null }) as unknown as LlmContentBlock;
const call = (id: string, name: string, input: unknown) => ({ type: 'tool_use', id, name, input }) as unknown as LlmContentBlock;
const useStub = (stub: StubProvider) => setLlmProviderFactory(async () => stub);
const lastToolResult = (req: LlmRequest) => {
  const last = req.messages.at(-1)!;
  return (Array.isArray(last.content) ? last.content : []).filter((b) => (b as { type: string }).type === 'tool_result') as Array<{ tool_use_id: string; content: string; is_error?: boolean }>;
};

async function agentWith(a: TestOrg, over: Partial<Parameters<typeof svc.createAgent>[1]> = {}) {
  return a.as((ctx) =>
    svc.createAgent(ctx, {
      type: 'stream-watch',
      name: 'Watcher',
      goal: 'Keep an eye on the catalogue',
      model: 'claude-opus-5-5',
      toolAllowlist: ['catalogue_search', 'agents_remember', 'agents_recall'],
      role: 'manager',
      approvalPolicy: { risk: { read: 'auto', write: 'auto', external: 'approve', destructive: 'approve', spend: 'approve' } },
      budget: { perRunUsd: 5, perDayUsd: 20 },
      ...over,
    }),
  );
}
const runOnce = (a: TestOrg, runId: string, attempt = 0) => runJob(jobs, 'agents.run', a.org.id, { runId }, { attempts: 5, attemptsMade: attempt });
const getRun = (a: TestOrg, id: string) => a.as((ctx) => svc.getRun(ctx, id));
const events = async (orgId: string, type: string) => systemDb().select().from(domainEvents).where(and(eq(domainEvents.orgId, orgId), eq(domainEvents.type, type)));

describe('agent runtime', () => {
  it('runs the reasoning loop: tool calls against real services, checkpoints, memory, cost', async () => {
    const a = await makeOrg();
    await a.as(async (ctx) => {
      const artist = await createArtist(ctx, { name: 'Mara Ellis', status: 'active' });
      await ctx.tx.insert(releases).values({ title: 'Tidewater', type: 'single', status: 'scheduled' });
      return artist;
    });
    const agent = await agentWith(a);
    const stub = new StubProvider((req, n) => {
      if (n === 1) return [say('Looking for the focus track.'), call('tu_1', 'catalogue_search', { q: 'Tidewater' })];
      if (n === 2) return [call('tu_2', 'agents_remember', { content: 'Tidewater is the current focus single', kind: 'fact', importance: 0.8 })];
      return [say('Found Tidewater (scheduled). Noted it as the focus single.')];
    });
    useStub(stub);
    const run = await a.as((ctx) => svc.startRun(ctx, { agentId: agent.id, triggerKind: 'manual', task: 'Find the focus track' }));
    expect(await runOnce(a, run.id)).toEqual({ status: 'completed' });

    const d = await getRun(a, run.id);
    expect(d.run).toMatchObject({ status: 'completed', result: 'Found Tidewater (scheduled). Noted it as the focus single.', stepCount: 3 });
    expect(d.steps.map((s) => s.kind)).toEqual(['plan', 'tool_call', 'message', 'tool_call', 'message']);
    expect(Number(d.run.costUsd)).toBeCloseTo(3 * (2_000 * 4 + 300 * 20) / 1e6, 6);
    // The model saw the real search result, in a tool_result for the right call.
    const [result] = lastToolResult(stub.calls[1]);
    expect(result.tool_use_id).toBe('tu_1');
    expect(result.content).toContain('Tidewater');
    // The system prompt and tool list were the same on every call (frozen per run).
    expect(new Set(stub.calls.map((c) => c.system)).size).toBe(1);
    expect(stub.calls.every((c) => JSON.stringify(c.tools) === JSON.stringify(stub.calls[0].tools))).toBe(true);
    expect(stub.calls[0].tools.map((t) => (t as { name: string }).name)).toEqual(['catalogue_search', 'agents_remember', 'agents_recall']);
    // Memory: the fact it chose to keep, plus the run's outcome.
    const mem = await a.as((ctx) => ctx.tx.select().from(memories).where(eq(memories.agentId, agent.id)));
    expect(mem.map((m) => m.kind).sort()).toEqual(['fact', 'outcome']);
    expect((await events(a.org.id, 'agents.run.started')).length).toBe(1);
    expect((await events(a.org.id, 'agents.run.completed')).map((e) => (e.payload as { runId: string }).runId)).toEqual([run.id]);

    // The next run recalls what was learned.
    const stub2 = new StubProvider(() => [say('ok')]);
    useStub(stub2);
    const run2 = await a.as((ctx) => svc.startRun(ctx, { agentId: agent.id, triggerKind: 'manual', task: 'What is the focus single?' }));
    await runOnce(a, run2.id);
    expect(JSON.stringify(stub2.calls[0].messages[0])).toContain('Tidewater is the current focus single');
  });

  it('pauses for approval, then executes the edited action once approved', async () => {
    const a = await makeOrg();
    const artist = await a.as((ctx) => createArtist(ctx, { name: 'Juno Vale', status: 'onboarding' }));
    const agent = await agentWith(a, { toolAllowlist: ['people_update_artist_status'] });
    const stub = new StubProvider((req, n) => (n === 1 ? [call('tu_a', 'people_update_artist_status', { id: artist.id, status: 'active', reason: 'Contract signed' })] : [say(`Result: ${lastToolResult(req)[0]?.content}`)]));
    useStub(stub);
    const run = await a.as((ctx) => svc.startRun(ctx, { agentId: agent.id, triggerKind: 'manual', task: 'Update Juno' }));
    expect(await runOnce(a, run.id)).toEqual({ status: 'waiting_approval' });
    const [pending] = await a.as((ctx) => svc.listApprovals(ctx, { status: 'pending' }));
    expect(pending.approval).toMatchObject({ toolName: 'people_update_artist_status', risk: 'write' });
    expect(pending.approval.preview).toContain('Contract signed');
    expect((await events(a.org.id, 'agents.approval.requested')).length).toBe(1);
    expect((await a.as((ctx) => getArtist(ctx, artist.id))).status).toBe('onboarding'); // nothing happened yet

    // An agent can't approve its own action, and a bad edit is rejected.
    await expect(a.as((ctx) => svc.decide(ctx, pending.approval.id, { decision: 'approve', editedPayload: { id: artist.id, status: 'retired', reason: 'x' } }))).rejects.toThrow(/does not match/);
    await a.as((ctx) => svc.decide(ctx, pending.approval.id, { decision: 'approve', editedPayload: { id: artist.id, status: 'paused', reason: 'Not yet: paperwork pending' } }));
    expect((await getRun(a, run.id)).run.status).toBe('queued');
    expect(await runOnce(a, run.id)).toEqual({ status: 'completed' });
    expect((await a.as((ctx) => getArtist(ctx, artist.id))).status).toBe('paused');
    expect(stub.calls).toHaveLength(2);

    // Rejection comes back to the model as a refusal.
    const stub2 = new StubProvider((req, n) => (n === 1 ? [call('tu_b', 'people_update_artist_status', { id: artist.id, status: 'alumni', reason: 'Dropped' })] : [say(lastToolResult(req)[0].content)]));
    useStub(stub2);
    const run2 = await a.as((ctx) => svc.startRun(ctx, { agentId: agent.id, triggerKind: 'manual', task: 'Drop Juno' }));
    await runOnce(a, run2.id);
    const [p2] = await a.as((ctx) => svc.listApprovals(ctx, { status: 'pending' }));
    await a.as((ctx) => svc.decide(ctx, p2.approval.id, { decision: 'reject', reason: 'We are keeping Juno' }));
    await runOnce(a, run2.id);
    const r2 = await getRun(a, run2.id);
    expect(r2.run.result).toContain('rejected this action: We are keeping Juno');
    expect((await a.as((ctx) => getArtist(ctx, artist.id))).status).toBe('paused');
  });

  it('survives a crash: resumes from the checkpoint without repeating side effects', async () => {
    const a = await makeOrg();
    const agent = await agentWith(a, { toolAllowlist: ['catalogue_create_release_draft'] });
    let crash = true;
    const stub = new StubProvider((req, n) => {
      if (n === 1) return [call('tu_c', 'catalogue_create_release_draft', { title: 'Paper Lanterns' })];
      if (crash) return new ProviderError('anthropic', 'connection reset', { transient: true });
      return [say('Draft created.')];
    });
    useStub(stub);
    const run = await a.as((ctx) => svc.startRun(ctx, { agentId: agent.id, triggerKind: 'manual', task: 'Draft the release' }));
    // The model call after the tool fails transiently: the run is released and the job retried.
    await expect(runOnce(a, run.id, 0)).rejects.toThrow(/connection reset/);
    expect((await getRun(a, run.id)).run.status).toBe('queued');
    crash = false;
    expect(await runOnce(a, run.id, 1)).toEqual({ status: 'completed' });
    const drafts = await a.as((ctx) => ctx.tx.select().from(releases).where(eq(releases.title, 'Paper Lanterns')));
    expect(drafts).toHaveLength(1);

    // A worker that died while holding the lease: the run is reclaimed once the lease runs out.
    const stub2 = new StubProvider(() => [say('done')]);
    useStub(stub2);
    const run2 = await a.as((ctx) => svc.startRun(ctx, { agentId: agent.id, triggerKind: 'manual', task: 'x' }));
    await a.as((ctx) => ctx.tx.update(runs).set({ status: 'running', leaseOwner: 'dead-worker', leaseExpiresAt: new Date(Date.now() + 60_000) }).where(eq(runs.id, run2.id)));
    expect(await runOnce(a, run2.id)).toEqual({ skipped: 'not claimable' });
    await a.as((ctx) => ctx.tx.update(runs).set({ leaseExpiresAt: new Date(Date.now() - 120_000) }).where(eq(runs.id, run2.id)));
    expect(await runOnce(a, run2.id)).toEqual({ status: 'completed' });

    // Died mid tool call (key claimed, no result): a non-idempotent action is never blindly repeated.
    const stub3 = new StubProvider((req, n) => (n === 1 ? [call('tu_d', 'catalogue_create_release_draft', { title: 'Ghost Draft' })] : [say(lastToolResult(req)[0].content)]));
    useStub(stub3);
    const run3 = await a.as((ctx) => svc.startRun(ctx, { agentId: agent.id, triggerKind: 'manual', task: 'y' }));
    await a.as((ctx) => ctx.tx.insert(idempotencyKeys).values({ key: `${run3.id}:tu_d`, status: 'in_progress' }));
    await runOnce(a, run3.id);
    expect((await getRun(a, run3.id)).run.result).toMatch(/may already have run/);
    expect(await a.as((ctx) => ctx.tx.select().from(releases).where(eq(releases.title, 'Ghost Draft')))).toHaveLength(0);
  });

  it('stops at its budget, its step limit and the kill switch', async () => {
    const a = await makeOrg();
    const agent = await agentWith(a, { budget: { perRunUsd: 0.01, perDayUsd: 1 } });
    useStub(new StubProvider(() => [call(`tu_${Math.random()}`, 'agents_recall', { query: 'anything' })], { inputTokens: 5_000, outputTokens: 100, cacheReadTokens: 0, cacheWriteTokens: 0, webSearchRequests: 0 }));
    const run = await a.as((ctx) => svc.startRun(ctx, { agentId: agent.id, triggerKind: 'manual', task: 'loop' }));
    expect(await runOnce(a, run.id)).toEqual({ status: 'budget_exceeded' });
    expect((await getRun(a, run.id)).run.error).toMatch(/per-run budget/);
    expect((await events(a.org.id, 'agents.run.failed')).map((e) => (e.payload as { status: string }).status)).toEqual(['budget_exceeded']);

    const looper = await agentWith(a, { name: 'Looper', maxSteps: 3 });
    useStub(new StubProvider((r, n) => [call(`tu_${n}`, 'agents_recall', { query: 'again' })]));
    const run2 = await a.as((ctx) => svc.startRun(ctx, { agentId: looper.id, triggerKind: 'manual', task: 'loop' }));
    expect(await runOnce(a, run2.id)).toEqual({ status: 'failed' });
    expect((await getRun(a, run2.id)).run).toMatchObject({ stepCount: 3, error: 'Reached its limit of 3 steps before finishing' });

    // Kill switch: queued runs stop at once and nothing new starts.
    const run3 = await a.as((ctx) => svc.startRun(ctx, { agentId: looper.id, triggerKind: 'manual', task: 'later' }));
    await a.as((ctx) => svc.setKillSwitch(ctx, true));
    expect((await getRun(a, run3.id)).run.status).toBe('stopped');
    await expect(a.as((ctx) => svc.startRun(ctx, { agentId: looper.id, triggerKind: 'manual' }))).rejects.toBeInstanceOf(ConflictError);
    await a.as((ctx) => svc.setKillSwitch(ctx, false));

    // Pause and resume a queued run.
    const run4 = await a.as((ctx) => svc.startRun(ctx, { agentId: looper.id, triggerKind: 'manual' }));
    await a.as((ctx) => svc.controlRun(ctx, run4.id, 'pause'));
    expect((await getRun(a, run4.id)).run.status).toBe('paused');
    await a.as((ctx) => svc.controlRun(ctx, run4.id, 'resume'));
    expect((await getRun(a, run4.id)).run.status).toBe('queued');
  });

  it('delegates to a specialist: the parent waits, the child inherits the stricter permissions, results flow back', async () => {
    const a = await makeOrg();
    const specialist = await agentWith(a, { name: 'Specialist', role: 'viewer', toolAllowlist: ['catalogue_search'], budget: { perRunUsd: 1, perDayUsd: 5 } });
    const manager = await agentWith(a, { type: 'label-manager', name: 'Manager', role: 'manager', toolAllowlist: ['agents_list', 'agents_delegate_task'] });
    const stub = new StubProvider((req) => {
      if (req.system.includes('You are "Specialist"')) return [say('Checked: no releases need attention.')];
      const results = lastToolResult(req);
      if (results.length === 0) return [call('tu_m1', 'agents_delegate_task', { agentId: specialist.id, task: 'Check the catalogue for releases missing artwork.' })];
      return [say(`Specialist says: ${JSON.parse(results[0].content).result}`)];
    });
    useStub(stub);
    const parent = await a.as((ctx) => svc.startRun(ctx, { agentId: manager.id, triggerKind: 'manual', task: 'Weekly review' }));
    expect(await runOnce(a, parent.id)).toEqual({ status: 'waiting_child' });
    const [child] = await a.as((ctx) => ctx.tx.select().from(runs).where(eq(runs.parentRunId, parent.id)));
    expect(child).toMatchObject({ triggerKind: 'delegation', agentId: specialist.id, status: 'queued' });
    // The child can only do what both agents may do.
    expect(child.permissions).not.toContain('catalogue:write');
    expect(child.permissions.every((p) => (parent.permissions as string[]).includes(p))).toBe(true);

    expect(await runOnce(a, child.id)).toEqual({ status: 'completed' });
    expect((await getRun(a, parent.id)).run.status).toBe('queued'); // woken by the child
    expect(await runOnce(a, parent.id)).toEqual({ status: 'completed' });
    const d = await getRun(a, parent.id);
    expect(d.run.result).toBe('Specialist says: Checked: no releases need attention.');
    expect(d.steps.map((s) => s.kind)).toContain('delegation');
    expect(d.children.map((c) => c.run.id)).toEqual([child.id]);
  });

  it('starts runs from cron and event triggers, never from its own events', async () => {
    useStub(new StubProvider(() => [say('ok')]));
    const a = await makeOrg();
    const agent = await agentWith(a);
    await a.as((ctx) => svc.addTrigger(ctx, agent.id, { kind: 'cron', cron: '0 8 * * 1' }));
    await a.as((ctx) => svc.addTrigger(ctx, agent.id, { kind: 'event', eventType: 'catalogue.demo.submitted', task: 'Score the demo' }));
    const { token } = await a.as((ctx) => svc.addTrigger(ctx, agent.id, { kind: 'webhook' }));
    expect(token).toMatch(/^[\w-]{20,}$/);

    // Make the cron trigger due and tick.
    await systemDb().update(triggers).set({ nextRunAt: new Date(Date.now() - 1000) }).where(and(eq(triggers.agentId, agent.id), eq(triggers.kind, 'cron')));
    await runJob(jobs, 'agents.tick', null);
    const cronRuns = await a.as((ctx) => ctx.tx.select().from(runs).where(and(eq(runs.agentId, agent.id), eq(runs.triggerKind, 'cron'))));
    expect(cronRuns).toHaveLength(1);
    const [cronTrigger] = await a.as((ctx) => ctx.tx.select().from(triggers).where(and(eq(triggers.agentId, agent.id), eq(triggers.kind, 'cron'))));
    expect(cronTrigger.nextRunAt!.getTime()).toBeGreaterThan(Date.now());

    const listener = allModules.find((m) => m.manifest.id === 'agents')!.listeners!.find((l) => l.id === 'agents.event-triggers')!;
    const fire = (actor: string | null, createdAt = new Date()) => withSystemOrg(a.org.id, (ctx) => listener.handle(ctx, { id: 1, orgId: a.org.id, type: 'catalogue.demo.submitted', payload: { demoId: 'd1', title: 'Late Bloom' }, actor, createdAt } as never));
    await fire(null);
    await fire(`agent:${agent.id}`);
    // Delivered late, but it happened before the trigger existed: not this trigger's business.
    await fire(null, new Date(Date.now() - 3_600_000));
    const eventRuns = await a.as((ctx) => ctx.tx.select().from(runs).where(and(eq(runs.agentId, agent.id), eq(runs.triggerKind, 'event'))));
    expect(eventRuns).toHaveLength(1);
    expect(eventRuns[0]).toMatchObject({ task: 'Score the demo', input: { event: 'catalogue.demo.submitted', demoId: 'd1', title: 'Late Bloom' } });
  });

  it('starts nothing without a model key: manual runs say why, triggers skip quietly', async () => {
    setLlmProviderFactory(null);
    const a = await makeOrg();
    const agent = await agentWith(a);
    await expect(a.as((ctx) => svc.startRun(ctx, { agentId: agent.id, triggerKind: 'manual', task: 'Go' }))).rejects.toBeInstanceOf(ValidationError);
    await a.as((ctx) => svc.addTrigger(ctx, agent.id, { kind: 'cron', cron: '0 8 * * 1' }));
    await systemDb().update(triggers).set({ nextRunAt: new Date(Date.now() - 1000) }).where(eq(triggers.agentId, agent.id));
    await runJob(jobs, 'agents.tick', null);
    expect(await a.as((ctx) => ctx.tx.select().from(runs).where(eq(runs.agentId, agent.id)))).toHaveLength(0);
    // The schedule still moves on, so it fires normally once a key is added.
    const [t] = await systemDb().select().from(triggers).where(eq(triggers.agentId, agent.id));
    expect(t.nextRunAt!.getTime()).toBeGreaterThan(Date.now());
  });

  it('caps an agent at its owner\'s permissions and freezes them on the run', async () => {
    const a = await makeOrg();
    const [viewer] = await systemDb().insert(users).values({ email: `viewer-${Date.now()}@example.test`, name: 'Vi Ewer', passwordHash: 'x' }).returning();
    await systemDb().insert(memberships).values({ orgId: a.org.id, userId: viewer.id, role: 'viewer', status: 'active' });
    const agent = await agentWith(a, { role: 'manager', toolAllowlist: ['catalogue_search', 'catalogue_create_release_draft'] });
    await a.as((ctx) => ctx.tx.update(agents).set({ ownerUserId: viewer.id }).where(eq(agents.id, agent.id)));
    const stub = new StubProvider((req, n) => (n === 1 ? [call('tu_v', 'catalogue_create_release_draft', { title: 'Not allowed' })] : [say(lastToolResult(req)[0]?.content ?? 'none')]));
    useStub(stub);
    const run = await a.as((ctx) => svc.startRun(ctx, { agentId: agent.id, triggerKind: 'manual', task: 'try' }));
    expect(run.permissions).toContain('catalogue:read');
    expect(run.permissions).not.toContain('catalogue:write');
    await runOnce(a, run.id);
    // The write tool wasn't even offered, and calling it anyway is refused.
    expect(stub.calls[0].tools.map((t) => (t as { name: string }).name)).toEqual(['catalogue_search']);
    expect((await getRun(a, run.id)).run.result).toMatch(/not available to this agent/);
    expect(await a.as((ctx) => ctx.tx.select().from(steps).where(and(eq(steps.runId, run.id), eq(steps.isError, true))))).toHaveLength(1);
    expect(await a.as((ctx) => ctx.tx.select().from(approvals))).toHaveLength(0);
  });
});
