import '../types';
import { and, asc, desc, eq, gte, inArray, isNull, lt, sql } from 'drizzle-orm';
import { z } from 'zod';
import { memberPermissions } from '@labelconsole/core/auth';
import type { ServiceContext } from '@labelconsole/core/context';
import { organizations } from '@labelconsole/core/db/schema';
import { env } from '@labelconsole/core/env';
import { ConflictError, ForbiddenError, NotFoundError, ValidationError } from '@labelconsole/core/errors';
import { PermissionSet } from '@labelconsole/core/permissions';
import { enqueueAfterCommit } from '@labelconsole/core/queue';
import { llmConfigured } from '@labelconsole/core/usage';
import { publish } from '@labelconsole/core/realtime';
import { approvals, agents, runs, steps, TERMINAL_STATUSES, type Agent, type Run, type RunStatus } from '../schema';

export type StartRunInput = {
  agentId: string;
  triggerKind: 'manual' | 'cron' | 'event' | 'webhook' | 'delegation';
  triggerId?: string | null;
  task?: string | null;
  input?: Record<string, unknown>;
  parentRunId?: string | null;
};

/**
 * What a run may do: the agent's role, capped by its owner's own permissions
 * (an agent never exceeds the person responsible for it), and for delegated
 * runs, by the parent run's permissions as well.
 */
export async function effectivePermissions(ctx: ServiceContext, agent: Agent, parent?: Run | null) {
  const owner = await memberPermissions(agent.ownerUserId, ctx.orgId);
  if (!owner) return null;
  let set = PermissionSet.forRole(agent.role).intersect(owner);
  if (parent) set = set.intersect(new PermissionSet(parent.permissions));
  return set;
}

/** Create a run and queue it for a worker. Used by every trigger, by people and by delegation. */
export async function startRun(ctx: ServiceContext, input: StartRunInput) {
  if (input.triggerKind === 'manual') ctx.assert('agents:run');
  const [agent] = await ctx.tx.select().from(agents).where(eq(agents.id, input.agentId));
  if (!agent) throw new NotFoundError('Agent');
  if (agent.status !== 'active') throw new ConflictError(`${agent.name} is ${agent.status}`);
  const [org] = await ctx.tx.select({ paused: organizations.agentsPaused }).from(organizations).where(eq(organizations.id, ctx.orgId));
  if (org?.paused) throw new ConflictError('All agents are stopped by the kill switch');
  // Refuse up front rather than queue a run that can only fail at its first model call.
  if (!(await llmConfigured(ctx))) throw new ValidationError('No Anthropic API key is configured. Add one under Settings → Integrations, or set ANTHROPIC_API_KEY for the platform.');
  const parent = input.parentRunId ? (await ctx.tx.select().from(runs).where(eq(runs.id, input.parentRunId)))[0] : null;
  const perms = await effectivePermissions(ctx, agent, parent);
  if (!perms) throw new ForbiddenError(`${agent.name}'s owner is no longer a member of this label, so it can't run`);
  const [run] = await ctx.tx
    .insert(runs)
    .values({ agentId: agent.id, triggerKind: input.triggerKind, triggerId: input.triggerId ?? null, task: input.task?.slice(0, 4000) ?? null, input: input.input ?? {}, parentRunId: input.parentRunId ?? null, status: 'queued', permissions: perms.toArray(), currentTask: 'Queued' })
    .returning();
  await ctx.audit({ action: 'agent.run_started', module: 'agents', targetType: 'agent', targetId: agent.id, targetLabel: agent.name, after: { runId: run.id, trigger: input.triggerKind } });
  queueRun(ctx, run.id);
  ctx.afterCommit(() => publishRun(ctx.orgId, run, agent.name));
  return run;
}

/** Hand the run to the agents queue (a fresh job id each time, so resumes aren't deduped away). */
export function queueRun(ctx: ServiceContext, runId: string, delayMs = 0) {
  enqueueAfterCommit(ctx, 'agents.run', { runId }, { jobId: `run-${runId}-${Date.now().toString(36)}`, attempts: 5, backoff: { type: 'exponential', delay: 15_000 }, delay: delayMs || undefined, queue: 'agents' });
}

export function publishRun(orgId: string, run: Pick<Run, 'id' | 'agentId' | 'status' | 'currentTask' | 'stepCount' | 'costUsd' | 'parentRunId'>, agentName?: string) {
  return publish(orgId, { type: 'agents.run.updated', data: { runId: run.id, agentId: run.agentId, agentName, status: run.status, currentTask: run.currentTask, stepCount: run.stepCount, costUsd: Number(run.costUsd), parentRunId: run.parentRunId }, permission: 'agents:read' }).catch(() => undefined);
}

export async function getRunRow(ctx: ServiceContext, id: string) {
  ctx.assert('agents:read');
  const [row] = await ctx.tx.select().from(runs).where(eq(runs.id, id));
  if (!row) throw new NotFoundError('Run');
  return row;
}

/** A run with its steps, approvals, children and parent: everything the live view shows. */
export async function getRun(ctx: ServiceContext, id: string) {
  const run = await getRunRow(ctx, id);
  const [agent] = await ctx.tx.select().from(agents).where(eq(agents.id, run.agentId));
  const [stepRows, approvalRows, children, parent] = await Promise.all([
    ctx.tx.select().from(steps).where(eq(steps.runId, id)).orderBy(asc(steps.index)),
    ctx.tx.select().from(approvals).where(eq(approvals.runId, id)).orderBy(asc(approvals.createdAt)),
    ctx.tx.select({ run: runs, agentName: agents.name }).from(runs).innerJoin(agents, eq(agents.id, runs.agentId)).where(eq(runs.parentRunId, id)).orderBy(asc(runs.createdAt)),
    run.parentRunId ? ctx.tx.select({ run: runs, agentName: agents.name }).from(runs).innerJoin(agents, eq(agents.id, runs.agentId)).where(eq(runs.id, run.parentRunId)).then((r) => r[0] ?? null) : null,
  ]);
  return { run, agent, steps: stepRows, approvals: approvalRows, children, parent };
}

export const RunQuery = z.object({ agentId: z.uuid().optional(), status: z.string().max(30).optional(), limit: z.coerce.number().int().min(1).max(500).default(100) });

export async function listRuns(ctx: ServiceContext, q: Partial<z.infer<typeof RunQuery>> = {}) {
  ctx.assert('agents:read');
  const conds = [];
  if (q.agentId) conds.push(eq(runs.agentId, q.agentId));
  if (q.status === 'active') conds.push(inArray(runs.status, ['queued', 'running', 'waiting_approval', 'waiting_child', 'paused']));
  else if (q.status) conds.push(eq(runs.status, q.status as RunStatus));
  return ctx.tx
    .select({ run: runs, agentName: agents.name, agentType: agents.type })
    .from(runs)
    .innerJoin(agents, eq(agents.id, runs.agentId))
    .where(conds.length ? and(...conds) : undefined)
    .orderBy(desc(runs.createdAt))
    .limit(q.limit ?? 100);
}

/* ------------------------------------------------------------ control --- */

/**
 * Pause, resume or stop. Pause and stop are written as the run's desired
 * state; the runtime honours them between steps. Stop also aborts in-flight
 * calls through the control channel.
 */
export async function controlRun(ctx: ServiceContext, id: string, action: 'pause' | 'resume' | 'stop') {
  ctx.assert('agents:run');
  const run = await getRunRow(ctx, id);
  if (TERMINAL_STATUSES.includes(run.status)) throw new ConflictError(`This run has already ${run.status === 'completed' ? 'finished' : run.status}`);
  if (action === 'pause') {
    const idle = run.status === 'queued' || run.status === 'waiting_approval' || run.status === 'waiting_child';
    await ctx.tx.update(runs).set({ desiredState: 'paused', ...(idle && run.status === 'queued' ? { status: 'paused', currentTask: 'Paused' } : {}) }).where(eq(runs.id, id));
  } else if (action === 'resume') {
    if (run.status !== 'paused' && run.desiredState !== 'paused') throw new ConflictError('This run is not paused');
    await ctx.tx.update(runs).set({ desiredState: 'run', status: run.status === 'paused' ? 'queued' : run.status, currentTask: 'Resuming' }).where(eq(runs.id, id));
    if (run.status === 'paused') queueRun(ctx, id);
  } else {
    const running = run.status === 'running';
    await ctx.tx.update(runs).set({ desiredState: 'stopped', ...(running ? {} : { status: 'stopped', endedAt: new Date(), endReason: 'Stopped by a person', leaseOwner: null, leaseExpiresAt: null }) }).where(eq(runs.id, id));
    // Waiting approvals for a stopped run can't be acted on any more.
    await ctx.tx.update(approvals).set({ status: 'expired', reason: 'Run stopped' }).where(and(eq(approvals.runId, id), eq(approvals.status, 'pending')));
    if (running) ctx.afterCommit(async () => (await import('../runtime/control')).sendControl(id, 'kill'));
    // Stopping a parent stops what it delegated.
    const children = await ctx.tx.select({ id: runs.id }).from(runs).where(and(eq(runs.parentRunId, id), inArray(runs.status, ['queued', 'running', 'waiting_approval', 'waiting_child', 'paused'])));
    for (const c of children) await controlRun(ctx, c.id, 'stop');
  }
  await ctx.audit({ action: `agent.run_${action}`, module: 'agents', targetType: 'run', targetId: id });
  const [after] = await ctx.tx.select().from(runs).where(eq(runs.id, id));
  ctx.afterCommit(() => publishRun(ctx.orgId, after));
  return after;
}

/* ---------------------------------------------------------- limits --- */

/** Runs currently holding a worker in this org (for the per-org concurrency cap). */
export async function runningCount(ctx: ServiceContext, exceptRunId: string) {
  const [row] = await ctx.tx
    .select({ n: sql<number>`count(*)::int` })
    .from(runs)
    .where(and(eq(runs.status, 'running'), sql`${runs.leaseExpiresAt} > now()`, sql`${runs.id} <> ${exceptRunId}`));
  return row?.n ?? 0;
}

export const concurrencyLimit = () => env().AGENT_CONCURRENCY_PER_ORG;

/** Spend today for one agent across its runs. */
export async function agentSpendToday(ctx: ServiceContext, agentId: string) {
  const since = new Date(new Date().toISOString().slice(0, 10) + 'T00:00:00Z');
  const [row] = await ctx.tx.select({ cost: sql<string>`coalesce(sum(${runs.costUsd}), 0)` }).from(runs).where(and(eq(runs.agentId, agentId), gte(runs.createdAt, since)));
  return Number(row?.cost ?? 0);
}

/** Usage for the agents usage page: cost per day and per agent. */
export async function usage(ctx: ServiceContext, days = 30) {
  ctx.assert('agents:read');
  const since = new Date(Date.now() - (days - 1) * 86400_000);
  since.setUTCHours(0, 0, 0, 0);
  const [byDay, byAgent, totals] = await Promise.all([
    ctx.tx.select({ day: sql<string>`to_char(${runs.createdAt}, 'YYYY-MM-DD')`, cost: sql<string>`sum(${runs.costUsd})`, runs: sql<number>`count(*)::int` }).from(runs).where(gte(runs.createdAt, since)).groupBy(sql`1`).orderBy(sql`1`),
    ctx.tx
      .select({ agentId: runs.agentId, name: agents.name, cost: sql<string>`sum(${runs.costUsd})`, runs: sql<number>`count(*)::int`, tokensIn: sql<number>`sum(${runs.tokensIn})::bigint`, tokensOut: sql<number>`sum(${runs.tokensOut})::bigint`, failed: sql<number>`count(*) filter (where ${runs.status} in ('failed', 'budget_exceeded'))::int` })
      .from(runs)
      .innerJoin(agents, eq(agents.id, runs.agentId))
      .where(gte(runs.createdAt, since))
      .groupBy(runs.agentId, agents.name)
      .orderBy(sql`3 desc`),
    ctx.tx.select({ month: sql<string>`coalesce(sum(${runs.costUsd}) filter (where ${runs.createdAt} >= date_trunc('month', now())), 0)` }).from(runs),
  ]);
  const [org] = await ctx.tx.select({ settings: organizations.settings }).from(organizations).where(eq(organizations.id, ctx.orgId));
  return {
    byDay: byDay.map((d) => ({ day: d.day, costUsd: Number(d.cost), runs: d.runs })),
    byAgent: byAgent.map((a) => ({ ...a, cost: Number(a.cost), tokensIn: Number(a.tokensIn), tokensOut: Number(a.tokensOut) })),
    monthUsd: Number(totals[0]?.month ?? 0),
    monthlyBudgetUsd: (org?.settings as { agentMonthlyBudgetUsd?: number | null } | undefined)?.agentMonthlyBudgetUsd ?? null,
  };
}

/** Runs whose worker died: lease long expired while marked running. The tick re-queues them. */
export async function stalledRuns(ctx: ServiceContext) {
  return ctx.tx.select({ id: runs.id }).from(runs).where(and(eq(runs.status, 'running'), lt(runs.leaseExpiresAt, new Date(Date.now() - 60_000)))).limit(50);
}

export async function pendingApprovalCount(ctx: ServiceContext) {
  const [row] = await ctx.tx.select({ n: sql<number>`count(*)::int` }).from(approvals).where(eq(approvals.status, 'pending'));
  return row?.n ?? 0;
}

export async function activeRunCount(ctx: ServiceContext) {
  const [row] = await ctx.tx.select({ n: sql<number>`count(*)::int` }).from(runs).where(inArray(runs.status, ['queued', 'running']));
  return row?.n ?? 0;
}

