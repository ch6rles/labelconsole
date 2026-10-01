import './types';
import { and, eq, gte, sql } from 'drizzle-orm';
import { defineListener, defineModule } from '@labelconsole/core/modules';
import { llmConfigured } from '@labelconsole/core/usage';
import { tools } from './agent-tools';
import { routes } from './api';
import { jobs } from './jobs';
import { manifest } from './manifest';
import { agents, runs, triggers, type TriggerConfig } from './schema';
import * as svc from './service';

/** Domain events that start agents. Agent and inbox events are excluded so agents can't trigger each other in loops. */
const eventTriggers = defineListener({
  id: 'agents.event-triggers',
  event: '*' as never,
  handle: async (ctx, event) => {
    const e = event as unknown as { type: string; actor: string | null; payload: unknown; createdAt: Date };
    if (e.type.startsWith('agents.') || e.type.startsWith('inbox.')) return;
    const rows = await ctx.tx
      .select({ trigger: triggers, agent: agents })
      .from(triggers)
      .innerJoin(agents, eq(agents.id, triggers.agentId))
      .where(and(eq(triggers.kind, 'event'), eq(triggers.enabled, true), eq(agents.status, 'active'), sql`${triggers.config} ->> 'eventType' = ${e.type}`));
    const payload = (e.payload ?? {}) as Record<string, unknown>;
    for (const { trigger, agent } of rows) {
      const config = trigger.config as Extract<TriggerConfig, { kind: 'event' }>;
      // An agent's own actions never re-trigger it.
      if (e.actor === `agent:${agent.id}`) continue;
      // Events are delivered asynchronously; one that happened before the trigger existed doesn't fire it.
      if (new Date(e.createdAt) < trigger.createdAt) continue;
      if (config.filter && Object.entries(config.filter).some(([k, v]) => String(payload[k] ?? '') !== v)) continue;
      try {
        await svc.startRun(ctx, { agentId: agent.id, triggerKind: 'event', triggerId: trigger.id, task: config.task ?? `Event: ${e.type}`, input: { event: e.type, ...payload } });
        await ctx.tx.update(triggers).set({ lastFiredAt: new Date() }).where(eq(triggers.id, trigger.id));
      } catch {
        // Kill switch on, agent paused or owner gone: the event simply doesn't start it.
      }
    }
  },
});

export default defineModule({
  manifest,
  routes,
  onboarding: async (ctx) => {
    const [[r], hasModel] = await Promise.all([ctx.tx.select({ n: sql<number>`count(*)::int` }).from(agents), llmConfigured(ctx)]);
    return [{ id: 'agent', title: 'Put an agent to work', sub: hasModel ? 'Start from a type: briefings, outreach, stream watch and more' : 'Add an Anthropic API key under Integrations first, then start from a type', done: (r?.n ?? 0) > 0 && hasModel, href: hasModel ? '/agents/new' : '/settings/integrations', order: 70 }];
  },
  jobs,
  tools,
  listeners: [eventTriggers],
  schedules: [{ id: 'agents-tick', job: 'agents.tick', everyMs: 60_000 }],
  shell: async (ctx) => ({
    runningAgents: ctx.can('agents:read') ? await svc.activeRunCount(ctx) : 0,
    pendingApprovals: ctx.can('agents:approve') ? await svc.pendingApprovalCount(ctx) : 0,
  }),
  attention: async (ctx) => {
    if (!ctx.can('agents:read')) return [];
    const [pending, failed] = await Promise.all([
      svc.pendingApprovalCount(ctx),
      ctx.tx.select({ n: sql<number>`count(*)::int` }).from(runs).where(and(sql`${runs.status} in ('failed', 'budget_exceeded')`, gte(runs.endedAt, new Date(Date.now() - 86400_000)))),
    ]);
    return [
      { n: ctx.can('agents:approve') ? pending : 0, tone: 'red', title: 'Agent actions waiting for approval', sub: 'Emails, offers and edits agents want to make', href: '/inbox/approvals' },
      { n: failed[0]?.n ?? 0, tone: 'ink', title: 'Agent runs that failed today', sub: 'Errors and budget stops in the last 24 hours', href: '/agents/runs?status=failed' },
    ];
  },
});
