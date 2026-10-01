import { eq, sql } from 'drizzle-orm';
import { z } from 'zod';
import { compact, defineTool } from '@labelconsole/core/tools';
import { agentType } from '../agent-types';
import { agents } from '../schema';
import { MemoryInput, recall, remember } from '../service/memory';

export const tools = [
  defineTool({
    name: 'agents_list',
    module: 'agents',
    description: 'List the label\'s active agents you can delegate to: their id, name, type, goal and per-run budget.',
    input: z.object({}),
    permission: 'agents:read',
    risk: 'read',
    idempotent: true,
    execute: (t) =>
      t.withOrg(async (ctx) => {
        const rows = await ctx.tx.select().from(agents).where(sql`${agents.status} = 'active' and ${agents.id} <> ${t.agentId}`);
        return compact(rows.map((a) => ({ id: a.id, name: a.name, type: agentType(a.type)?.name ?? a.type, goal: a.goal, budgetPerRunUsd: a.budget.perRunUsd })));
      }),
  }),
  defineTool({
    name: 'agents_delegate_task',
    module: 'agents',
    description:
      'Hand a self-contained task to another agent (see agents_list). Your run waits until that agent finishes and you receive its result. The delegated run can only do what both of you are allowed to do, and its cost counts against your budget. Delegate one clear task at a time with everything the other agent needs to know.',
    input: z.object({ agentId: z.uuid(), task: z.string().min(10).max(4000) }),
    permission: 'agents:run',
    risk: 'write',
    timeoutMs: 30_000,
    preview: (i) => `Delegate to agent ${i.agentId}: ${i.task.slice(0, 200)}`,
    // Starting an agent whose budget is bigger than what this run has left needs a person.
    approvalReason: async (t, i) => {
      const target = await t.withOrg(async (ctx) => (await ctx.tx.select().from(agents).where(eq(agents.id, i.agentId)))[0]);
      if (!target) return null;
      if (t.remainingBudgetUsd != null && target.budget.perRunUsd > t.remainingBudgetUsd) return `${target.name} can spend up to $${target.budget.perRunUsd.toFixed(2)}, more than the $${Math.max(0, t.remainingBudgetUsd).toFixed(2)} left in this run's budget`;
      return null;
    },
    execute: async (t, i) => {
      if (!t.delegate) throw new Error('Delegation is not available here');
      return t.delegate({ agentId: i.agentId, task: i.task });
    },
  }),
  defineTool({
    name: 'agents_remember',
    module: 'agents',
    description: 'Save a durable memory for future runs: a fact about the label, a preference, or an outcome worth knowing next time. Use scope "org" only for things every agent should know. Not for routine results.',
    input: MemoryInput.pick({ content: true, kind: true, importance: true, scope: true }),
    permission: 'agents:read',
    risk: 'write',
    idempotent: true,
    execute: (t, i) => t.withOrg(async (ctx) => ({ id: (await remember(ctx, t.agentId, i, t.runId)).id, saved: true })),
  }),
  defineTool({
    name: 'agents_recall',
    module: 'agents',
    description: 'Search what you and the label\'s other agents remember (facts, preferences, past outcomes) for a topic.',
    input: z.object({ query: z.string().min(2).max(300), limit: z.number().int().min(1).max(20).default(8) }),
    permission: 'agents:read',
    risk: 'read',
    idempotent: true,
    execute: (t, i) => t.withOrg(async (ctx) => (await recall(ctx, t.agentId, i.query, i.limit)).map((m) => ({ kind: m.kind, content: m.content, importance: m.importance, scope: m.agentId ? 'agent' : 'org', saved: m.createdAt.toISOString().slice(0, 10) }))),
  }),
];
