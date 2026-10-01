import '../types';
import { hostname } from 'node:os';
import { and, eq, inArray, isNull, lt, or, sql } from 'drizzle-orm';
import { withOrg, type ServiceContext } from '@labelconsole/core/context';
import { idempotencyKeys, organizations, type OrgSettings } from '@labelconsole/core/db/schema';
import { logger } from '@labelconsole/core/logger';
import { AppError, isTransient, ProviderError, RateLimitedError } from '@labelconsole/core/errors';
import { COMPACTION_PROMPT, responseText, thinkingSummary, toolUses, type LlmContentBlock, type LlmMessage, type LlmProvider, type LlmTool } from '@labelconsole/core/llm';
import { modelInfo, priceUsage } from '@labelconsole/core/llm-models';
import { toolByName } from '@labelconsole/core/modules';
import { PermissionSet } from '@labelconsole/core/permissions';
import type { JobContext } from '@labelconsole/core/queue';
import { acquire } from '@labelconsole/core/ratelimit';
import { toolJsonSchema, type ToolContext, type ToolDefinition } from '@labelconsole/core/tools';
import { llmProviderFor, monthUsage, recordUsage } from '@labelconsole/core/usage';
import { getCredentialHandle } from '@labelconsole/core/vault';
import { agentType } from '../agent-types';
import { agents, approvals, runs, steps, TERMINAL_STATUSES, type Agent, type Checkpoint, type PendingCall, type Run, type StepKind } from '../schema';
import { recall, remember } from '../service/memory';
import { agentSpendToday, concurrencyLimit, publishRun, queueRun, startRun } from '../service/runs';
import { trackRun } from './control';
import { approxTokens, buildFirstMessage, buildSystemPrompt } from './prompt';

const LEASE_MS = 90_000;
const HEARTBEAT_MS = 20_000;
const COMPACT_AT_TOKENS = 120_000;
const APPROVAL_TTL_MS = 72 * 3600_000;
const MAX_DELEGATION_DEPTH = 3;

type Outcome = { content: string; isError: boolean };
type ToolStep = { result: Outcome } | { pending: PendingCall };

class StopRun extends Error {
  constructor(readonly status: 'stopped' | 'paused', readonly reason: string) {
    super(reason);
  }
}

/**
 * Execute one agent run until it finishes or has to wait (approval, child
 * run, pause). Every step is checkpointed, so a crashed worker's run resumes
 * from its last completed step when the job is retried or the tick re-queues it.
 */
export async function executeRun(job: JobContext, runId: string) {
  const orgId = job.orgId!;
  const workerId = `${hostname()}:${process.pid}:${job.job.id}`;
  const sys = <T>(fn: (ctx: ServiceContext) => Promise<T>) => job.withOrg(fn);

  // Claim the run under a per-org advisory lock so the concurrency cap holds across workers.
  const claim = await sys(async (ctx) => {
    await ctx.tx.execute(sql`select pg_advisory_xact_lock(hashtext(${`agents:${orgId}`}))`);
    const [busy] = await ctx.tx.select({ n: sql<number>`count(*)::int` }).from(runs).where(and(eq(runs.status, 'running'), sql`${runs.leaseExpiresAt} > now()`, sql`${runs.id} <> ${runId}`, sql`${runs.leaseOwner} is distinct from ${workerId}`));
    const [candidate] = await ctx.tx.select({ status: runs.status }).from(runs).where(eq(runs.id, runId));
    if (!candidate) return { skip: 'missing' as const };
    if (candidate.status === 'queued' && (busy?.n ?? 0) >= concurrencyLimit()) return { skip: 'busy' as const };
    const [row] = await ctx.tx
      .update(runs)
      .set({ status: 'running', leaseOwner: workerId, leaseExpiresAt: new Date(Date.now() + LEASE_MS), heartbeatAt: new Date(), attempts: sql`${runs.attempts} + 1`, startedAt: sql`coalesce(${runs.startedAt}, now())` })
      .where(and(eq(runs.id, runId), inArray(runs.status, ['queued', 'running']), or(isNull(runs.leaseExpiresAt), lt(runs.leaseExpiresAt, new Date()), eq(runs.leaseOwner, workerId))))
      .returning();
    return row ? { run: row } : { skip: 'not claimable' as const };
  });
  if ('skip' in claim) {
    // Over the org's concurrency cap: back off without spending a retry. Jittered so a
    // label's queued runs don't all retry in the same instant (measured in test/load).
    if (claim.skip === 'busy') throw new RateLimitedError(1_500 + Math.round(Math.random() * 2_500), 'Agent concurrency limit reached for this label');
    return { skipped: claim.skip };
  }

  let run = claim.run;
  const segmentStart = Date.now();
  const tracked = trackRun(runId);
  const heartbeat = setInterval(() => {
    void sys((ctx) => ctx.tx.update(runs).set({ leaseExpiresAt: new Date(Date.now() + LEASE_MS), heartbeatAt: new Date() }).where(and(eq(runs.id, runId), eq(runs.leaseOwner, workerId)))).catch(() => undefined);
  }, HEARTBEAT_MS);

  try {
    const loaded = await sys(async (ctx) => {
      const [agent] = await ctx.tx.select().from(agents).where(eq(agents.id, run.agentId));
      const [org] = await ctx.tx.select().from(organizations).where(eq(organizations.id, orgId));
      return { agent, org };
    });
    const agent = loaded.agent;
    const org = loaded.org;
    const perms = new PermissionSet(run.permissions);
    const provider = await sys((ctx) => llmProviderFor(ctx));

    // First start: freeze the prompt and the tool set for the whole run.
    let cp: Checkpoint = run.checkpoint ?? (await initCheckpoint(sys, agent, run, org.name, org.settings));
    if (!run.checkpoint) {
      await save(sys, run.id, cp, { currentTask: 'Planning' });
      await sys((ctx) => ctx.emit('agents.run.started', { runId: run.id, agentId: agent.id, agentName: agent.name }));
    }
    const tools = cp.tools.map((n) => toolByName(n)).filter((t): t is ToolDefinition => Boolean(t));
    const llmTools = buildLlmTools(cp.tools, agent);

    for (;;) {
      // 1. Honour the kill switch, stop and pause, between steps.
      const control = await sys(async (ctx) => {
        const [r] = await ctx.tx.select().from(runs).where(eq(runs.id, runId));
        const [o] = await ctx.tx.select({ paused: organizations.agentsPaused }).from(organizations).where(eq(organizations.id, orgId));
        return { run: r, killSwitch: Boolean(o?.paused) };
      });
      run = control.run;
      if (control.killSwitch) throw new StopRun('stopped', 'Stopped by the kill switch');
      if (run.desiredState === 'stopped') throw new StopRun('stopped', 'Stopped by a person');
      if (run.desiredState === 'paused') throw new StopRun('paused', 'Paused by a person');

      // 2. Limits.
      if (run.stepCount >= agent.maxSteps) return await finish(sys, run, agent, 'failed', { error: `Reached its limit of ${agent.maxSteps} steps before finishing` });
      // Measured over active execution: time spent waiting for people or child runs doesn't count.
      if (Date.now() - segmentStart > agent.maxRuntimeSec * 1000) return await finish(sys, run, agent, 'failed', { error: `Ran past its time limit of ${Math.round(agent.maxRuntimeSec / 60)} minutes` });

      // 3. Calls waiting on a person or a child run.
      if (cp.pending.length) {
        const waited = await wait(sys, run, cp);
        if (waited) return waited;
      }

      // 4. Execute the tool calls of the latest assistant turn, one at a time, checkpointing each.
      const last = cp.messages.at(-1)!;
      if (last.role === 'assistant') {
        const uses = toolUses(last.content as LlmContentBlock[]);
        for (const u of uses) {
          if (cp.results[u.id] || cp.pending.some((p) => p.toolUseId === u.id)) continue;
          const outcome = await handleToolUse(sys, { run, agent, perms, cp, tools, signal: tracked.signal, orgId }, u);
          if ('pending' in outcome) cp.pending.push(outcome.pending);
          else cp.results[u.id] = outcome.result;
          await save(sys, run.id, cp, { currentTask: 'pending' in outcome ? `Waiting: ${u.name}` : `Ran ${u.name}` });
        }
        if (cp.pending.length) {
          const waited = await wait(sys, run, cp);
          if (waited) return waited;
          continue;
        }
        if (uses.length) {
          cp.messages.push({ role: 'user', content: uses.map((u) => ({ type: 'tool_result' as const, tool_use_id: u.id, content: cp.results[u.id].content, ...(cp.results[u.id].isError ? { is_error: true } : {}) })) });
          cp.results = {};
          await save(sys, run.id, cp, {});
          continue;
        }
      }

      // 5. Budgets, checked before every model call.
      const block = await budgetBlock(sys, agent, run, org.settings);
      if (block) return await finish(sys, run, agent, 'budget_exceeded', { error: block });

      // 6. Keep the context bounded.
      if (approxTokens(cp.messages) > COMPACT_AT_TOKENS) {
        cp = await compact(sys, provider, run, agent, cp, llmTools, tracked.signal);
        continue;
      }

      // 7. Ask the model for the next step.
      const started = Date.now();
      const res = await provider.chat({ model: agent.model, system: cp.system, messages: cp.messages, tools: llmTools, effort: agent.effort as never, maxTokens: 16_000, signal: tracked.signal });
      const cost = priceUsage(res.model, res.usage);
      let content = res.content;
      if (res.stopReason === 'max_tokens') content = stripToolUses(content);
      cp.messages.push({ role: 'assistant', content: content as LlmMessage['content'] });
      if (res.stopReason === 'max_tokens') cp.messages.push({ role: 'user', content: 'Your reply was cut off by the length limit. Continue, and keep each tool input short.' });
      const text = responseText(res.content);
      const calls = toolUses(content);
      const isFirst = run.stepCount === 0;
      await sys(async (ctx) => {
        await addStep(ctx, run, {
          kind: isFirst ? 'plan' : 'message',
          summary: (text || thinkingSummary(res.content) || (calls.length ? `Calling ${calls.map((c) => c.name).join(', ')}` : '')).slice(0, 2000),
          output: { text, thinking: thinkingSummary(res.content).slice(0, 4000) || undefined, toolCalls: calls.map((c) => ({ name: c.name, input: c.input })), stopReason: res.stopReason },
          tokensIn: res.usage.inputTokens + res.usage.cacheReadTokens + res.usage.cacheWriteTokens,
          tokensOut: res.usage.outputTokens,
          costUsd: cost,
          durationMs: Date.now() - started,
          model: res.model,
        });
        await ctx.tx
          .update(runs)
          .set({ checkpoint: cp, stepCount: sql`${runs.stepCount} + 1`, tokensIn: sql`${runs.tokensIn} + ${res.usage.inputTokens + res.usage.cacheReadTokens + res.usage.cacheWriteTokens}`, tokensOut: sql`${runs.tokensOut} + ${res.usage.outputTokens}`, costUsd: sql`${runs.costUsd} + ${cost}`, currentTask: calls.length ? `Calling ${calls.map((c) => c.name).join(', ')}`.slice(0, 200) : 'Writing the answer', leaseExpiresAt: new Date(Date.now() + LEASE_MS) })
          .where(eq(runs.id, run.id));
        await recordUsage(ctx, 'agent_cost_usd', cost);
        await recordUsage(ctx, 'agent_tokens', res.usage.inputTokens + res.usage.outputTokens);
      });
      run = await reload(sys, run.id);
      void publishRun(orgId, run, agent.name);

      if (res.stopReason === 'refusal') return await finish(sys, run, agent, 'failed', { error: `The model declined to continue this task${res.stopDetails?.explanation ? `: ${res.stopDetails.explanation}` : ''}` });
      if (res.stopReason === 'model_context_window_exceeded') {
        cp = await compact(sys, provider, run, agent, cp, llmTools, tracked.signal);
        continue;
      }
      // A final answer: no client tool calls left to make.
      if (calls.length === 0 && res.stopReason !== 'pause_turn' && res.stopReason !== 'max_tokens') return await finish(sys, run, agent, 'completed', { result: text || '(no answer)' });
    }
  } catch (err) {
    return await handleError(job, sys, runId, err);
  } finally {
    clearInterval(heartbeat);
    tracked.done();
  }
}

/* --------------------------------------------------------------- setup -- */

async function initCheckpoint(sys: <T>(fn: (ctx: ServiceContext) => Promise<T>) => Promise<T>, agent: Agent, run: Run, orgName: string, settings: OrgSettings): Promise<Checkpoint> {
  const type = agentType(agent.type);
  const perms = new PermissionSet(run.permissions);
  // Only tools the agent is allowed AND whose permission its run actually holds.
  const toolNames = agent.toolAllowlist.filter((n) => {
    const t = toolByName(n);
    return t && perms.has(t.permission);
  });
  const mems = await sys((ctx) => recall(ctx, agent.id, `${run.task ?? ''} ${agent.goal}`, 8));
  return { system: buildSystemPrompt(agent, type, { name: orgName, settings }), tools: toolNames, messages: [{ role: 'user', content: buildFirstMessage(run, mems) }], results: {}, pending: [], compactions: 0 };
}

function buildLlmTools(names: string[], agent: Agent): LlmTool[] {
  const out: LlmTool[] = names.map((n) => {
    const t = toolByName(n);
    // A module switched off mid-run keeps its slot (stable prompt), but can't be called.
    return t ? ({ name: t.name, description: t.description, input_schema: toolJsonSchema(t) } as LlmTool) : ({ name: n, description: 'Currently unavailable.', input_schema: { type: 'object', properties: {} } } as LlmTool);
  });
  if (agent.webResearch) out.push({ type: modelInfo(agent.model).webSearchTool, name: 'web_search', max_uses: 5 } as unknown as LlmTool);
  return out;
}

function stripToolUses(content: LlmContentBlock[]): LlmContentBlock[] {
  const kept = content.filter((b) => b.type !== 'tool_use');
  return kept.length ? kept : ([{ type: 'text', text: '(cut off)' }] as unknown as LlmContentBlock[]);
}

/* ---------------------------------------------------------------- tools -- */

type ToolEnv = { run: Run; agent: Agent; perms: PermissionSet; cp: Checkpoint; tools: ToolDefinition[]; signal: AbortSignal; orgId: string };

async function handleToolUse(sys: <T>(fn: (ctx: ServiceContext) => Promise<T>) => Promise<T>, env: ToolEnv, u: { id: string; name: string; input: unknown }): Promise<ToolStep> {
  const tool = env.cp.tools.includes(u.name) ? toolByName(u.name) : undefined;
  const fail = async (message: string): Promise<ToolStep> => {
    await sys((ctx) => addStep(ctx, env.run, { kind: 'tool_call', toolName: u.name, toolUseId: u.id, input: u.input, output: { error: message }, isError: true, summary: `${u.name}: ${message}`.slice(0, 500) }));
    return { result: { content: message, isError: true } };
  };
  if (!tool) return fail(`The tool ${u.name} is not available to this agent.`);
  const parsed = tool.input.safeParse(u.input);
  if (!parsed.success) return fail(`Invalid input for ${u.name}: ${parsed.error.issues.map((i) => `${i.path.join('.') || 'input'} ${i.message}`).join('; ')}`);
  if (!env.perms.has(tool.permission)) return fail(`Not permitted: ${u.name} needs ${tool.permission}, which this agent doesn't have.`);

  let input: unknown = parsed.data;
  const [existing] = await sys((ctx) => ctx.tx.select().from(approvals).where(and(eq(approvals.runId, env.run.id), eq(approvals.toolUseId, u.id))));
  if (existing) {
    if (existing.status === 'pending') return { pending: { toolUseId: u.id, name: u.name, input, approvalId: existing.id } };
    if (existing.status !== 'approved') return { result: { content: `A person ${existing.status === 'expired' ? 'did not approve this in time' : 'rejected this action'}${existing.reason ? `: ${existing.reason}` : '.'} Do not retry it unchanged.`, isError: true } };
    input = existing.editedPayload ?? existing.payload;
  } else {
    const toolCtx = makeToolContext(env, u.id, undefined);
    const policy = env.agent.approvalPolicy;
    let decision = tool.requiresApproval ? 'approve' : (policy.tools?.[tool.name] ?? policy.risk[tool.risk] ?? 'approve');
    const reason = await tool.approvalReason?.(await toolCtx, input as never);
    if (reason && decision === 'auto') decision = 'approve';
    if (decision === 'deny') return fail(`This agent's policy does not allow ${tool.risk} actions like ${u.name}.`);
    if (decision === 'approve') {
      const preview = (tool.preview?.(input as never) ?? `${u.name} ${JSON.stringify(input).slice(0, 300)}`) + (reason ? ` (${reason})` : '');
      const approvalId = await sys(async (ctx) => {
        const step = await addStep(ctx, env.run, { kind: 'approval', toolName: u.name, toolUseId: u.id, input, summary: `Waiting for approval: ${preview}`.slice(0, 500) });
        const [a] = await ctx.tx
          .insert(approvals)
          .values({ runId: env.run.id, stepId: step.id, agentId: env.agent.id, toolName: u.name, toolUseId: u.id, risk: tool.risk, preview: preview.slice(0, 2000), payload: input as never, expiresAt: new Date(Date.now() + APPROVAL_TTL_MS) })
          .onConflictDoNothing()
          .returning();
        if (a) await ctx.emit('agents.approval.requested', { approvalId: a.id, runId: env.run.id, agentId: env.agent.id, agentName: env.agent.name, ownerUserId: env.agent.ownerUserId, tool: u.name, preview: a.preview, risk: tool.risk });
        return a?.id ?? (await ctx.tx.select({ id: approvals.id }).from(approvals).where(and(eq(approvals.runId, env.run.id), eq(approvals.toolUseId, u.id))))[0].id;
      });
      return { pending: { toolUseId: u.id, name: u.name, input, approvalId } };
    }
  }
  return executeTool(sys, env, tool, u.id, input);
}

async function makeToolContext(env: ToolEnv, toolUseId: string, stepId: string | undefined): Promise<ToolContext> {
  const actor = { type: 'agent' as const, id: env.agent.id, name: env.agent.name, runId: env.run.id, stepId, ownerUserId: env.agent.ownerUserId };
  const scoped = <T>(fn: (ctx: ServiceContext) => Promise<T>) => withOrg({ orgId: env.orgId, actor, permissions: env.perms }, fn);
  const remaining = await scoped((ctx) => remainingBudget(ctx, env.run, env.agent));
  return {
    orgId: env.orgId,
    agentId: env.agent.id,
    runId: env.run.id,
    stepId: stepId ?? '',
    idempotencyKey: `${env.run.id}:${toolUseId}`,
    signal: env.signal,
    log: logger.child({ runId: env.run.id, tool: toolUseId }),
    withOrg: scoped,
    credential: (provider) => scoped((ctx) => getCredentialHandle(ctx, provider)),
    remainingBudgetUsd: remaining,
    delegate: async ({ agentId, task }) => {
      if (agentId === env.agent.id) throw new AppError(422, 'validation_failed', 'An agent cannot delegate to itself');
      const depth = await scoped((ctx) => delegationDepth(ctx, env.run.id));
      if (depth >= MAX_DELEGATION_DEPTH) throw new AppError(422, 'validation_failed', `Delegation is limited to ${MAX_DELEGATION_DEPTH} levels`);
      const child = await withOrg({ orgId: env.orgId, actor: { type: 'system', name: `agent:${env.agent.name}` }, permissions: PermissionSet.fromPatterns(['*']) }, (ctx) => startRun(ctx, { agentId, triggerKind: 'delegation', task, parentRunId: env.run.id }));
      return { childRunId: child.id };
    },
  };
}

async function executeTool(sys: <T>(fn: (ctx: ServiceContext) => Promise<T>) => Promise<T>, env: ToolEnv, tool: ToolDefinition, toolUseId: string, input: unknown): Promise<ToolStep> {
  const key = `${env.run.id}:${toolUseId}`;
  const isDelegation = tool.name === 'agents_delegate_task';
  const preview = tool.preview?.(input as never) ?? tool.name;
  const [prior] = await sys((ctx) => ctx.tx.select().from(idempotencyKeys).where(eq(idempotencyKeys.key, key)));
  if (prior?.status === 'completed' && prior.result) {
    const step = await sys((ctx) => addStep(ctx, env.run, { kind: isDelegation ? 'delegation' : 'tool_call', toolName: tool.name, toolUseId, input, idempotencyKey: key, summary: `${preview} (result reused after restart)`.slice(0, 500) }));
    return finishTool(sys, env, tool, step.id, toolUseId, prior.result as Outcome & { childRunId?: string }, 0, preview);
  }
  if (prior && !tool.idempotent && tool.risk !== 'read') {
    // A worker died mid-call: the action may have happened. Never repeat a side effect blindly.
    const step = await sys((ctx) => addStep(ctx, env.run, { kind: 'tool_call', toolName: tool.name, toolUseId, input, idempotencyKey: key, summary: preview.slice(0, 500) }));
    return finishTool(sys, env, tool, step.id, toolUseId, { content: `${tool.name} was interrupted by a worker restart and may already have run. Check its effect before trying again.`, isError: true }, 0, preview);
  }
  // Rate limit per tool per label before claiming the key, so a backoff doesn't look like a crash.
  await acquire(`tool:${env.orgId}:${tool.name}`, tool.rateLimit ?? { capacity: 30, refillPerSec: 0.5 }, { maxWaitMs: 20_000, signal: env.signal });
  // The step exists before the call, so the live view shows it running and audit entries point at it.
  const step = await sys(async (ctx) => {
    await ctx.tx.insert(idempotencyKeys).values({ key, status: 'in_progress' }).onConflictDoNothing();
    await ctx.tx.update(runs).set({ currentTask: `Running ${tool.name}` }).where(eq(runs.id, env.run.id));
    return addStep(ctx, env.run, { kind: isDelegation ? 'delegation' : 'tool_call', toolName: tool.name, toolUseId, input, idempotencyKey: key, summary: `Running: ${preview}`.slice(0, 500) });
  });
  const toolCtx = await makeToolContext(env, toolUseId, step.id);
  const started = Date.now();
  let outcome: Outcome & { childRunId?: string };
  try {
    const out = await runWithRetries(tool, () => withTimeout(tool.execute(toolCtx, input as never), tool.timeoutMs ?? 60_000, env.signal));
    const childRunId = isDelegation ? (out as { childRunId?: string }).childRunId : undefined;
    const content = typeof out === 'string' ? out : JSON.stringify(out ?? null);
    outcome = { content: content.length > 20_000 ? `${content.slice(0, 20_000)}… (truncated)` : content, isError: false, ...(childRunId ? { childRunId } : {}) };
  } catch (err) {
    if (env.signal.aborted) throw err;
    if (err instanceof RateLimitedError) {
      await sys(async (ctx) => {
        await ctx.tx.delete(idempotencyKeys).where(eq(idempotencyKeys.key, key));
        await ctx.tx.delete(steps).where(eq(steps.id, step.id));
      });
      throw err;
    }
    outcome = { content: err instanceof AppError || err instanceof ProviderError ? err.message : `Tool failed: ${(err as Error).message}`, isError: true };
  }
  await sys((ctx) => ctx.tx.update(idempotencyKeys).set({ status: 'completed', result: outcome, completedAt: new Date() }).where(eq(idempotencyKeys.key, key)));
  return finishTool(sys, env, tool, step.id, toolUseId, outcome, Date.now() - started, preview);
}

async function finishTool(sys: <T>(fn: (ctx: ServiceContext) => Promise<T>) => Promise<T>, env: ToolEnv, tool: ToolDefinition, stepId: string, toolUseId: string, outcome: Outcome & { childRunId?: string }, durationMs: number, preview: string): Promise<ToolStep> {
  const delegated = tool.name === 'agents_delegate_task' && outcome.childRunId && !outcome.isError;
  await sys(async (ctx) => {
    const [row] = await ctx.tx
      .update(steps)
      .set({ kind: delegated ? 'delegation' : 'tool_call', output: safeJson(outcome.content), isError: outcome.isError, durationMs, summary: `${preview}${outcome.isError ? ` failed: ${outcome.content.slice(0, 200)}` : ''}`.slice(0, 500) })
      .where(eq(steps.id, stepId))
      .returning();
    if (row) ctx.afterCommit(() => import('@labelconsole/core/realtime').then(({ publish }) => publish(env.orgId, { type: 'agents.step.created', data: { runId: env.run.id, stepId: row.id, index: row.index, kind: row.kind, summary: row.summary }, permission: 'agents:read' })).catch(() => undefined));
  });
  if (delegated) return { pending: { toolUseId, name: tool.name, input: null, childRunId: outcome.childRunId, stepId } };
  return { result: { content: outcome.content, isError: outcome.isError } };
}

async function runWithRetries<T>(tool: ToolDefinition, fn: () => Promise<T>): Promise<T> {
  const retryable = tool.idempotent || tool.risk === 'read';
  for (let attempt = 0; ; attempt++) {
    try {
      return await fn();
    } catch (err) {
      if (!retryable || attempt >= 2 || !isTransient(err)) throw err;
      await new Promise((r) => setTimeout(r, 500 * 2 ** attempt + Math.random() * 250));
    }
  }
}

function withTimeout<T>(p: Promise<T>, ms: number, signal: AbortSignal): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const t = setTimeout(() => reject(new ProviderError('tool', `Timed out after ${Math.round(ms / 1000)}s`, { transient: true })), ms);
    const onAbort = () => reject(signal.reason ?? new Error('aborted'));
    signal.addEventListener('abort', onAbort, { once: true });
    p.then(resolve, reject).finally(() => {
      clearTimeout(t);
      signal.removeEventListener('abort', onAbort);
    });
  });
}

const safeJson = (s: string) => {
  try {
    return JSON.parse(s);
  } catch {
    return { text: s };
  }
};

/* -------------------------------------------------------------- waiting -- */

function childResult(child: Run): Outcome {
  return child.status === 'completed' ? { content: JSON.stringify({ status: 'completed', result: child.result }), isError: false } : { content: JSON.stringify({ status: child.status, error: child.error ?? child.endReason }), isError: true };
}

/**
 * Park the run until its pending calls are answered, or return null when they
 * already are. The check and the status change happen under the run's row
 * lock, which approval decisions and finishing child runs also take, so a
 * wake-up can never slip between "still waiting?" and "now waiting".
 */
async function wait(sys: <T>(fn: (ctx: ServiceContext) => Promise<T>) => Promise<T>, run: Run, cp: Checkpoint): Promise<{ status: string } | null> {
  const outcome = await sys(async (ctx) => {
    await ctx.tx.select({ id: runs.id }).from(runs).where(eq(runs.id, run.id)).for('update');
    const still: PendingCall[] = [];
    for (const p of cp.pending) {
      if (p.approvalId) {
        const [a] = await ctx.tx.select({ status: approvals.status }).from(approvals).where(eq(approvals.id, p.approvalId));
        // Decided approvals leave the pending list; the tool loop then executes or refuses the call.
        if (a?.status === 'pending') still.push(p);
      } else if (p.childRunId) {
        const [child] = await ctx.tx.select().from(runs).where(eq(runs.id, p.childRunId));
        if (child && TERMINAL_STATUSES.includes(child.status)) cp.results[p.toolUseId] = childResult(child);
        else still.push(p);
      }
    }
    cp.pending = still;
    if (still.length === 0) {
      await ctx.tx.update(runs).set({ checkpoint: cp }).where(eq(runs.id, run.id));
      return null;
    }
    const status = still.some((p) => p.approvalId) ? ('waiting_approval' as const) : ('waiting_child' as const);
    const [r] = await ctx.tx.update(runs).set({ status, checkpoint: cp, leaseOwner: null, leaseExpiresAt: null, currentTask: status === 'waiting_approval' ? `Waiting for approval (${still.length})` : 'Waiting for delegated work' }).where(eq(runs.id, run.id)).returning();
    return r;
  });
  if (!outcome) return null;
  void publishRun(run.orgId, outcome);
  return { status: outcome.status };
}

/* -------------------------------------------------------------- budgets -- */

/** Spend of a run plus everything it delegated, recursively. */
async function subtreeSpend(ctx: ServiceContext, runId: string) {
  const [row] = (await ctx.tx.execute(sql`
    with recursive tree as (select id, cost_usd from agent_runs where id = ${runId}
      union all select r.id, r.cost_usd from agent_runs r join tree t on r.parent_run_id = t.id)
    select coalesce(sum(cost_usd), 0) as spend from tree`)) as unknown as Array<{ spend: string }>;
  return Number(row?.spend ?? 0);
}

async function rootOf(ctx: ServiceContext, run: Run) {
  let cur = run;
  for (let i = 0; i < 10 && cur.parentRunId; i++) {
    const [p] = await ctx.tx.select().from(runs).where(eq(runs.id, cur.parentRunId));
    if (!p) break;
    cur = p;
  }
  return cur;
}

async function delegationDepth(ctx: ServiceContext, runId: string) {
  let depth = 0;
  let id: string | null = runId;
  while (id && depth < 10) {
    const [r] = await ctx.tx.select({ parent: runs.parentRunId }).from(runs).where(eq(runs.id, id));
    id = r?.parent ?? null;
    if (id) depth++;
  }
  return depth;
}

/** What is left before this run hits a limit: its own budget, and the delegating run's budget it draws on. */
async function remainingBudget(ctx: ServiceContext, run: Run, agent: Agent) {
  const own = agent.budget.perRunUsd - (await subtreeSpend(ctx, run.id));
  const root = await rootOf(ctx, run);
  if (root.id === run.id) return own;
  const [rootAgent] = await ctx.tx.select().from(agents).where(eq(agents.id, root.agentId));
  const tree = (rootAgent?.budget.perRunUsd ?? 0) - (await subtreeSpend(ctx, root.id));
  return Math.min(own, tree);
}

async function budgetBlock(sys: <T>(fn: (ctx: ServiceContext) => Promise<T>) => Promise<T>, agent: Agent, run: Run, settings: OrgSettings) {
  return sys(async (ctx) => {
    const remaining = await remainingBudget(ctx, run, agent);
    if (remaining <= 0) return run.parentRunId ? 'Used up the budget its manager gave it' : `Reached its per-run budget of $${agent.budget.perRunUsd.toFixed(2)}`;
    if ((await agentSpendToday(ctx, agent.id)) >= agent.budget.perDayUsd) return `Reached its daily budget of $${agent.budget.perDayUsd.toFixed(2)}`;
    if (settings.agentMonthlyBudgetUsd != null && (await monthUsage(ctx, 'agent_cost_usd')) >= settings.agentMonthlyBudgetUsd) return `The label reached its monthly agent budget of $${settings.agentMonthlyBudgetUsd.toFixed(2)}`;
    return null;
  });
}

/* ----------------------------------------------------------- compaction -- */

/** Simple client-side compaction: summarise the transcript and continue from the summary. */
async function compact(sys: <T>(fn: (ctx: ServiceContext) => Promise<T>) => Promise<T>, provider: LlmProvider, run: Run, agent: Agent, cp: Checkpoint, llmTools: LlmTool[], signal: AbortSignal): Promise<Checkpoint> {
  const msgs = [...cp.messages];
  const last = msgs.at(-1)!;
  const ask = { type: 'text' as const, text: COMPACTION_PROMPT };
  if (last.role === 'user') msgs[msgs.length - 1] = { role: 'user', content: typeof last.content === 'string' ? [{ type: 'text', text: last.content }, ask] : [...last.content, ask] };
  else msgs.push({ role: 'user', content: [ask] });
  const res = await provider.chat({ model: agent.model, system: cp.system, messages: msgs, tools: llmTools, effort: 'low', maxTokens: 8000, signal });
  const summary = responseText(res.content).match(/<summary>([\s\S]*?)<\/summary>/)?.[1]?.trim() ?? responseText(res.content);
  const first = typeof cp.messages[0].content === 'string' ? cp.messages[0].content : responseText(cp.messages[0].content as LlmContentBlock[]);
  const next: Checkpoint = { ...cp, messages: [{ role: 'user', content: `${first}\n\nProgress so far (a summary of your earlier steps):\n${summary}\n\nContinue from here.` }], results: {}, compactions: cp.compactions + 1 };
  const cost = priceUsage(res.model, res.usage);
  await sys(async (ctx) => {
    await addStep(ctx, run, { kind: 'compaction', summary: 'Summarised earlier steps to stay within the context window', output: { summary: summary.slice(0, 8000) }, tokensIn: res.usage.inputTokens, tokensOut: res.usage.outputTokens, costUsd: cost, model: res.model });
    await ctx.tx.update(runs).set({ checkpoint: next, costUsd: sql`${runs.costUsd} + ${cost}`, tokensIn: sql`${runs.tokensIn} + ${res.usage.inputTokens}`, tokensOut: sql`${runs.tokensOut} + ${res.usage.outputTokens}` }).where(eq(runs.id, run.id));
    await recordUsage(ctx, 'agent_cost_usd', cost);
  });
  return next;
}

/* ------------------------------------------------------------- finishing -- */

async function finish(sys: <T>(fn: (ctx: ServiceContext) => Promise<T>) => Promise<T>, run: Run, agent: Agent, status: 'completed' | 'failed' | 'stopped' | 'budget_exceeded', out: { result?: string; error?: string; reason?: string }) {
  const after = await sys(async (ctx) => {
    const [r] = await ctx.tx
      .update(runs)
      .set({ status, endedAt: new Date(), result: out.result ?? null, error: out.error ?? null, endReason: out.reason ?? out.error ?? (status === 'completed' ? 'Finished' : null), leaseOwner: null, leaseExpiresAt: null, currentTask: status === 'completed' ? 'Done' : (out.reason ?? out.error ?? status).slice(0, 200) })
      .where(eq(runs.id, run.id))
      .returning();
    if (status !== 'completed') await addStep(ctx, r, { kind: 'error', summary: (out.error ?? out.reason ?? status).slice(0, 500), output: { status, error: out.error ?? out.reason }, isError: status !== 'stopped' });
    // Outcomes become memories, so the next run knows what was done.
    if (status === 'completed' && out.result && run.task) await remember(ctx, agent.id, { content: `${new Date().toISOString().slice(0, 10)}: ${run.task.slice(0, 200)} → ${out.result.slice(0, 600)}`, kind: 'outcome', importance: 0.3, expiresAt: new Date(Date.now() + 180 * 86400_000) }, run.id);
    // Waiting approvals of a run that ended are moot.
    await ctx.tx.update(approvals).set({ status: 'expired', reason: `Run ${status}` }).where(and(eq(approvals.runId, run.id), eq(approvals.status, 'pending')));
    if (status === 'completed') await ctx.emit('agents.run.completed', { runId: r.id, agentId: agent.id, agentName: agent.name, parentRunId: r.parentRunId, result: out.result ?? null, costUsd: Number(r.costUsd) });
    else if (status !== 'stopped') await ctx.emit('agents.run.failed', { runId: r.id, agentId: agent.id, agentName: agent.name, ownerUserId: agent.ownerUserId, error: out.error ?? status, parentRunId: r.parentRunId, status });
    if (r.parentRunId) await resumeParent(ctx, r);
    return r;
  });
  void publishRun(run.orgId, after, agent.name);
  return { status };
}

/** A delegated run ended: hand its result to the parent and wake it once nothing else is pending. */
export async function resumeParent(ctx: ServiceContext, child: Run) {
  const [parent] = await ctx.tx.select().from(runs).where(eq(runs.id, child.parentRunId!)).for('update');
  // A running parent owns its checkpoint and checks its children before it waits.
  if (!parent?.checkpoint || parent.status !== 'waiting_child') return;
  const cp = parent.checkpoint;
  const p = cp.pending.find((x) => x.childRunId === child.id);
  if (!p) return;
  cp.results[p.toolUseId] = childResult(child);
  cp.pending = cp.pending.filter((x) => x !== p);
  const wake = cp.pending.length === 0 && parent.desiredState === 'run';
  await ctx.tx.update(runs).set({ checkpoint: cp, ...(wake ? { status: 'queued', currentTask: 'Delegated work came back' } : {}) }).where(eq(runs.id, parent.id));
  if (wake) queueRun(ctx, parent.id);
}

async function handleError(job: JobContext, sys: <T>(fn: (ctx: ServiceContext) => Promise<T>) => Promise<T>, runId: string, err: unknown) {
  const run = await reload(sys, runId);
  const [agent] = await sys((ctx) => ctx.tx.select().from(agents).where(eq(agents.id, run.agentId)));
  if (err instanceof StopRun) {
    if (err.status === 'paused') {
      const after = await sys(async (ctx) => (await ctx.tx.update(runs).set({ status: 'paused', leaseOwner: null, leaseExpiresAt: null, currentTask: 'Paused' }).where(eq(runs.id, runId)).returning())[0]);
      void publishRun(run.orgId, after, agent?.name);
      return { status: 'paused' };
    }
    return finish(sys, run, agent, 'stopped', { reason: err.reason });
  }
  if ((err as Error)?.name === 'AbortError' || (run.desiredState === 'stopped' && (err as Error)?.message?.includes('Stopped'))) return finish(sys, run, agent, 'stopped', { reason: 'Stopped by a person' });
  const lastAttempt = job.job.attemptsMade + 1 >= (job.job.opts?.attempts ?? 1);
  if (err instanceof RateLimitedError || (isTransient(err) && !lastAttempt)) {
    // Provider throttling or a transient failure: release the run and let the queue retry it from the checkpoint.
    await sys((ctx) => ctx.tx.update(runs).set({ status: 'queued', leaseOwner: null, leaseExpiresAt: null, currentTask: err instanceof RateLimitedError ? 'Rate limited, retrying shortly' : 'Retrying after a temporary error' }).where(eq(runs.id, runId)));
    throw err;
  }
  job.log.error({ err, runId }, 'agent run failed');
  return finish(sys, run, agent, 'failed', { error: err instanceof AppError || err instanceof ProviderError ? err.message : `Unexpected error: ${(err as Error)?.message ?? String(err)}` });
}

/* ---------------------------------------------------------------- utils -- */

async function reload(sys: <T>(fn: (ctx: ServiceContext) => Promise<T>) => Promise<T>, runId: string) {
  return sys(async (ctx) => (await ctx.tx.select().from(runs).where(eq(runs.id, runId)))[0]);
}

async function save(sys: <T>(fn: (ctx: ServiceContext) => Promise<T>) => Promise<T>, runId: string, cp: Checkpoint, extra: { currentTask?: string }) {
  await sys((ctx) => ctx.tx.update(runs).set({ checkpoint: cp, heartbeatAt: new Date(), leaseExpiresAt: new Date(Date.now() + LEASE_MS), ...extra }).where(eq(runs.id, runId)));
}

type StepInput = { kind: StepKind; toolName?: string; toolUseId?: string; summary?: string; input?: unknown; output?: unknown; tokensIn?: number; tokensOut?: number; costUsd?: number; durationMs?: number; idempotencyKey?: string; isError?: boolean; model?: string };

async function addStep(ctx: ServiceContext, run: Run, s: StepInput) {
  const [{ next }] = (await ctx.tx.execute(sql`select coalesce(max(index), -1) + 1 as next from agent_steps where run_id = ${run.id}`)) as unknown as Array<{ next: number }>;
  const [row] = await ctx.tx
    .insert(steps)
    .values({ runId: run.id, index: Number(next), kind: s.kind, toolName: s.toolName ?? null, toolUseId: s.toolUseId ?? null, summary: s.summary ?? null, input: (s.input ?? null) as never, output: (s.output ?? null) as never, tokensIn: s.tokensIn ?? 0, tokensOut: s.tokensOut ?? 0, costUsd: String(s.costUsd ?? 0), durationMs: s.durationMs ?? 0, idempotencyKey: s.idempotencyKey ?? null, isError: s.isError ?? false, model: s.model ?? null })
    .returning();
  ctx.afterCommit(() => import('@labelconsole/core/realtime').then(({ publish }) => publish(run.orgId, { type: 'agents.step.created', data: { runId: run.id, stepId: row.id, index: row.index, kind: row.kind, summary: row.summary }, permission: 'agents:read' })).catch(() => undefined));
  return row;
}
