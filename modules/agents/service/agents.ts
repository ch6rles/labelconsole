import '../types';
import { createHash, randomBytes } from 'node:crypto';
import cronParser from 'cron-parser';
import { and, asc, desc, eq, gte, inArray, sql } from 'drizzle-orm';
import { z } from 'zod';
import type { ServiceContext } from '@labelconsole/core/context';
import { organizations } from '@labelconsole/core/db/schema';
import { NotFoundError, ValidationError } from '@labelconsole/core/errors';
import { MODELS } from '@labelconsole/core/llm-models';
import { allTools, enabledModuleIds } from '@labelconsole/core/modules';
import { BUILT_IN_ROLES } from '@labelconsole/core/permissions';
import { publish } from '@labelconsole/core/realtime';
import { RISK_LEVELS } from '@labelconsole/core/tools';
import { patchOf } from '@labelconsole/core/zod';
import { agentType, AGENT_TYPES } from '../agent-types';
import { agents, AGENT_STATUSES, runs, triggers, type TriggerConfig } from '../schema';

const Decision = z.enum(['auto', 'approve', 'deny']);
export const PolicyInput = z.object({
  risk: z.object(Object.fromEntries(RISK_LEVELS.map((r) => [r, Decision])) as Record<(typeof RISK_LEVELS)[number], typeof Decision>),
  tools: z.record(z.string(), Decision).optional(),
});

export const AgentInput = z.object({
  type: z.string().refine((t) => Boolean(agentType(t)), 'Unknown agent type'),
  name: z.string().trim().min(1).max(120),
  goal: z.string().trim().min(1).max(2000),
  instructions: z.string().max(10_000).default(''),
  model: z.string().refine((m) => MODELS.some((x) => x.id === m), 'Unknown model'),
  effort: z.enum(['low', 'medium', 'high', 'xhigh', 'max']).default('high'),
  toolAllowlist: z.array(z.string()).max(60).default([]),
  role: z.enum(BUILT_IN_ROLES as unknown as [string, ...string[]]).default('viewer'),
  approvalPolicy: PolicyInput,
  budget: z.object({ perRunUsd: z.number().min(0.01).max(500), perDayUsd: z.number().min(0.01).max(5000) }),
  maxSteps: z.number().int().min(1).max(200).default(25),
  maxRuntimeSec: z.number().int().min(30).max(6 * 3600).default(1800),
  webResearch: z.boolean().default(false),
  status: z.enum(AGENT_STATUSES).default('active'),
});
export const AgentPatch = patchOf(AgentInput).omit({ type: true });

/** Tool names a label can give an agent: registered by modules it has switched on. */
export async function availableTools(ctx: ServiceContext) {
  const [org] = await ctx.tx.select({ id: organizations.id, plan: organizations.plan }).from(organizations).where(eq(organizations.id, ctx.orgId));
  return allTools(org ? await enabledModuleIds(ctx.tx, org) : undefined);
}

async function checkTools(ctx: ServiceContext, names: string[]) {
  const known = new Set((await availableTools(ctx)).map((t) => t.name));
  const unknown = names.filter((n) => !known.has(n));
  if (unknown.length) throw new ValidationError(`Unknown or unavailable tools: ${unknown.join(', ')}`, { fieldErrors: { toolAllowlist: ['Some tools are not available'] } });
}

/** A new agent from a type's defaults, owned by whoever creates it. */
export async function createAgent(ctx: ServiceContext, input: z.input<typeof AgentInput>) {
  ctx.assert('agents:manage');
  if (ctx.actor.type !== 'user') throw new ValidationError('Only people can create agents');
  const data = AgentInput.parse(input);
  const type = agentType(data.type)!;
  const toolAllowlist = data.toolAllowlist.length ? data.toolAllowlist : type.tools;
  await checkTools(ctx, toolAllowlist);
  const [row] = await ctx.tx.insert(agents).values({ ...data, toolAllowlist, ownerUserId: ctx.actor.id }).returning();
  await ctx.audit({ action: 'agent.created', module: 'agents', targetType: 'agent', targetId: row.id, targetLabel: row.name, after: { type: row.type, role: row.role, model: row.model, tools: toolAllowlist.length } });
  return row;
}

/** Create an agent straight from a type, with its suggested triggers. */
export async function createAgentFromType(ctx: ServiceContext, typeId: string, overrides: { name?: string; model?: string } = {}) {
  const t = agentType(typeId);
  if (!t) throw new ValidationError('Unknown agent type');
  const agent = await createAgent(ctx, { type: t.id, name: overrides.name ?? t.name, goal: t.defaultGoal, instructions: '', model: overrides.model ?? 'claude-opus-5-5', toolAllowlist: t.tools, role: t.role, approvalPolicy: t.approvalPolicy, budget: t.budget, maxSteps: t.maxSteps, webResearch: t.webResearch });
  for (const tr of t.triggers) if (tr.config.kind !== 'webhook') await addTrigger(ctx, agent.id, tr.config as never);
  return agent;
}

export async function getAgentRow(ctx: ServiceContext, id: string) {
  ctx.assert('agents:read');
  const [row] = await ctx.tx.select().from(agents).where(eq(agents.id, id));
  if (!row) throw new NotFoundError('Agent');
  return row;
}

export async function updateAgent(ctx: ServiceContext, id: string, patch: z.input<typeof AgentPatch>) {
  ctx.assert('agents:manage');
  const before = await getAgentRow(ctx, id);
  const data = AgentPatch.parse(patch);
  if (data.toolAllowlist) await checkTools(ctx, data.toolAllowlist);
  const [after] = await ctx.tx.update(agents).set(data).where(eq(agents.id, id)).returning();
  await ctx.audit({ action: data.status && data.status !== before.status ? 'agent.status_changed' : 'agent.updated', module: 'agents', targetType: 'agent', targetId: id, targetLabel: after.name, before: before as never, after: after as never });
  ctx.afterCommit(() => publish(ctx.orgId, { type: 'agents.agent.updated', data: { agentId: id, status: after.status }, permission: 'agents:read' }));
  return after;
}

export async function deleteAgent(ctx: ServiceContext, id: string) {
  ctx.assert('agents:manage');
  const a = await getAgentRow(ctx, id);
  // Archive instead of deleting when it has history, so costs and actions stay auditable.
  const [hasRuns] = await ctx.tx.select({ n: sql<number>`count(*)::int` }).from(runs).where(eq(runs.agentId, id));
  if ((hasRuns?.n ?? 0) > 0) {
    await ctx.tx.update(agents).set({ status: 'archived' }).where(eq(agents.id, id));
    await ctx.tx.update(triggers).set({ enabled: false }).where(eq(triggers.agentId, id));
    await ctx.audit({ action: 'agent.archived', module: 'agents', targetType: 'agent', targetId: id, targetLabel: a.name });
    return { archived: true };
  }
  await ctx.tx.delete(agents).where(eq(agents.id, id));
  await ctx.audit({ action: 'agent.deleted', module: 'agents', targetType: 'agent', targetId: id, targetLabel: a.name });
  return { deleted: true };
}

/** Agents with their latest run, next scheduled run and spend today. */
export async function listAgents(ctx: ServiceContext, opts: { includeArchived?: boolean } = {}) {
  ctx.assert('agents:read');
  const rows = await ctx.tx.select().from(agents).where(opts.includeArchived ? undefined : sql`${agents.status} <> 'archived'`).orderBy(asc(agents.name));
  const ids = rows.map((r) => r.id);
  if (ids.length === 0) return [];
  const since = new Date(new Date().toISOString().slice(0, 10) + 'T00:00:00Z');
  const [latest, spend, next] = await Promise.all([
    ctx.tx
      .selectDistinctOn([runs.agentId], { agentId: runs.agentId, id: runs.id, status: runs.status, currentTask: runs.currentTask, result: runs.result, createdAt: runs.createdAt, endedAt: runs.endedAt, endReason: runs.endReason })
      .from(runs)
      .where(inArray(runs.agentId, ids))
      .orderBy(runs.agentId, desc(runs.createdAt)),
    ctx.tx.select({ agentId: runs.agentId, cost: sql<string>`sum(${runs.costUsd})` }).from(runs).where(and(inArray(runs.agentId, ids), gte(runs.createdAt, since))).groupBy(runs.agentId),
    ctx.tx.select({ agentId: triggers.agentId, nextRunAt: sql<Date | null>`min(${triggers.nextRunAt})` }).from(triggers).where(and(inArray(triggers.agentId, ids), eq(triggers.enabled, true))).groupBy(triggers.agentId),
  ]);
  return rows.map((a) => ({
    ...a,
    typeName: agentType(a.type)?.name ?? a.type,
    icon: agentType(a.type)?.icon ?? 'smart_toy',
    lastRun: latest.find((l) => l.agentId === a.id) ?? null,
    costTodayUsd: Number(spend.find((s) => s.agentId === a.id)?.cost ?? 0),
    nextRunAt: next.find((n) => n.agentId === a.id)?.nextRunAt ?? null,
  }));
}

export function listTypes() {
  return AGENT_TYPES;
}

/* ---------------------------------------------------------- triggers --- */

export const TriggerInput = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('cron'), cron: z.string().trim().min(9).max(100), timezone: z.string().max(60).optional() }),
  z.object({ kind: z.literal('event'), eventType: z.string().min(3).max(80), filter: z.record(z.string(), z.string()).optional(), task: z.string().max(2000).optional() }),
  z.object({ kind: z.literal('webhook'), task: z.string().max(2000).optional() }),
  z.object({ kind: z.literal('manual') }),
]);

export function nextCronRun(cron: string, timezone = 'UTC', from = new Date()) {
  try {
    return cronParser.parseExpression(cron, { currentDate: from, tz: timezone }).next().toDate();
  } catch {
    throw new ValidationError('That is not a valid cron schedule', { fieldErrors: { cron: ['e.g. 0 8 * * 1 for Mondays at 08:00'] } });
  }
}

export const hashToken = (t: string) => createHash('sha256').update(t).digest('hex');

/** Add a trigger. Webhook triggers return their secret URL token once; only its hash is stored. */
export async function addTrigger(ctx: ServiceContext, agentId: string, input: z.input<typeof TriggerInput>) {
  ctx.assert('agents:manage');
  await getAgentRow(ctx, agentId);
  const data = TriggerInput.parse(input);
  let token: string | null = null;
  let config: TriggerConfig;
  let nextRunAt: Date | null = null;
  if (data.kind === 'cron') {
    const tz = data.timezone || ((await ctx.tx.select({ s: organizations.settings }).from(organizations).where(eq(organizations.id, ctx.orgId)))[0]?.s.timezone ?? 'UTC');
    nextRunAt = nextCronRun(data.cron, tz);
    config = { kind: 'cron', cron: data.cron, timezone: tz };
  } else if (data.kind === 'webhook') {
    token = randomBytes(24).toString('base64url');
    config = { kind: 'webhook', tokenHash: hashToken(token), task: data.task };
  } else config = data;
  const [row] = await ctx.tx.insert(triggers).values({ agentId, kind: data.kind, config, nextRunAt, tokenHash: config.kind === 'webhook' ? config.tokenHash : null }).returning();
  await ctx.audit({ action: 'agent.trigger_added', module: 'agents', targetType: 'agent', targetId: agentId, after: { kind: data.kind } });
  return { trigger: row, token };
}

export async function setTriggerEnabled(ctx: ServiceContext, id: string, enabled: boolean) {
  ctx.assert('agents:manage');
  const [t] = await ctx.tx.select().from(triggers).where(eq(triggers.id, id));
  if (!t) throw new NotFoundError('Trigger');
  const nextRunAt = enabled && t.config.kind === 'cron' ? nextCronRun(t.config.cron, t.config.timezone) : t.nextRunAt;
  const [row] = await ctx.tx.update(triggers).set({ enabled, nextRunAt }).where(eq(triggers.id, id)).returning();
  return row;
}

export async function deleteTrigger(ctx: ServiceContext, id: string) {
  ctx.assert('agents:manage');
  await ctx.tx.delete(triggers).where(eq(triggers.id, id));
}

export async function triggersFor(ctx: ServiceContext, agentId: string) {
  ctx.assert('agents:read');
  return ctx.tx.select().from(triggers).where(eq(triggers.agentId, agentId)).orderBy(asc(triggers.createdAt));
}

/* ------------------------------------------------------- kill switch --- */

/** Stop every agent in the label at once, or let them run again. */
export async function setKillSwitch(ctx: ServiceContext, paused: boolean) {
  ctx.assert('agents:manage');
  await ctx.tx.update(organizations).set({ agentsPaused: paused }).where(eq(organizations.id, ctx.orgId));
  if (paused) {
    // Active runs stop at their next checkpoint; in-flight model calls are aborted.
    const active = await ctx.tx.update(runs).set({ desiredState: 'stopped' }).where(inArray(runs.status, ['queued', 'running', 'waiting_approval', 'waiting_child', 'paused'])).returning({ id: runs.id, status: runs.status });
    for (const r of active) if (r.status !== 'running') await ctx.tx.update(runs).set({ status: 'stopped', endedAt: new Date(), endReason: 'Stopped by the kill switch' }).where(eq(runs.id, r.id));
    ctx.afterCommit(async () => {
      const { sendControl } = await import('../runtime/control');
      for (const r of active) await sendControl(r.id, 'kill');
    });
  }
  await ctx.audit({ action: paused ? 'agents.kill_switch_on' : 'agents.kill_switch_off', module: 'agents', targetType: 'organization', targetId: ctx.orgId });
  ctx.afterCommit(() => publish(ctx.orgId, { type: 'agents.run.updated', data: { killSwitch: paused }, permission: 'agents:read' }));
  return { paused };
}

export async function killSwitchState(ctx: ServiceContext) {
  const [o] = await ctx.tx.select({ paused: organizations.agentsPaused }).from(organizations).where(eq(organizations.id, ctx.orgId));
  return Boolean(o?.paused);
}

export async function recentRunsFor(ctx: ServiceContext, agentId: string) {
  return ctx.tx.select().from(runs).where(eq(runs.agentId, agentId)).orderBy(desc(runs.createdAt)).limit(20);
}
