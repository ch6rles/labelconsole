import { z } from 'zod';
import { defineRoutes, route } from '@labelconsole/core/router';
import { SOCIAL_PLATFORMS } from '@labelconsole/core/tools';
import * as svc from '../service';

export const routes = defineRoutes('agents', [
  route({ method: 'GET', path: '/agents', permission: 'agents:read', handler: (ctx) => svc.listAgents(ctx) }),
  route({ method: 'POST', path: '/agents', permission: 'agents:manage', body: svc.AgentInput, handler: (ctx, req) => svc.createAgent(ctx, req.body) }),
  route({ method: 'POST', path: '/agents/from-type', permission: 'agents:manage', body: z.object({ type: z.string(), name: z.string().trim().max(120).optional(), model: z.string().optional() }), handler: (ctx, req) => svc.createAgentFromType(ctx, req.body.type, req.body) }),
  route({ method: 'GET', path: '/agents/types', permission: 'agents:read', handler: async () => svc.listTypes() }),
  route({ method: 'GET', path: '/agents/tools', permission: 'agents:read', handler: async (ctx) => (await svc.availableTools(ctx)).map((t) => ({ name: t.name, module: t.module, description: t.description, risk: t.risk, permission: t.permission, requiresApproval: Boolean(t.requiresApproval) })) }),
  route({ method: 'GET', path: '/agents/:id', permission: 'agents:read', handler: async (ctx, req) => ({ agent: await svc.getAgentRow(ctx, req.params.id), triggers: await svc.triggersFor(ctx, req.params.id), runs: await svc.recentRunsFor(ctx, req.params.id) }) }),
  route({ method: 'PATCH', path: '/agents/:id', permission: 'agents:manage', body: svc.AgentPatch, handler: (ctx, req) => svc.updateAgent(ctx, req.params.id, req.body) }),
  route({ method: 'DELETE', path: '/agents/:id', permission: 'agents:manage', handler: (ctx, req) => svc.deleteAgent(ctx, req.params.id) }),
  route({
    method: 'POST',
    path: '/agents/:id/run',
    permission: 'agents:run',
    body: z.object({ task: z.string().trim().max(4000).nullish(), platforms: z.array(z.enum(SOCIAL_PLATFORMS)).max(SOCIAL_PLATFORMS.length).nullish() }),
    handler: (ctx, req) => svc.startRun(ctx, { agentId: req.params.id, triggerKind: 'manual', task: req.body.task || null, input: req.body.platforms?.length ? { platforms: req.body.platforms } : undefined }),
  }),
  route({ method: 'GET', path: '/agents/:id/triggers', permission: 'agents:read', handler: (ctx, req) => svc.triggersFor(ctx, req.params.id) }),
  route({ method: 'POST', path: '/agents/:id/triggers', permission: 'agents:manage', body: svc.TriggerInput, handler: (ctx, req) => svc.addTrigger(ctx, req.params.id, req.body) }),
  route({ method: 'PATCH', path: '/agent-triggers/:id', permission: 'agents:manage', body: z.object({ enabled: z.boolean() }), handler: (ctx, req) => svc.setTriggerEnabled(ctx, req.params.id, req.body.enabled) }),
  route({ method: 'DELETE', path: '/agent-triggers/:id', permission: 'agents:manage', handler: (ctx, req) => svc.deleteTrigger(ctx, req.params.id) }),

  route({ method: 'GET', path: '/agent-runs', permission: 'agents:read', query: svc.RunQuery, handler: (ctx, req) => svc.listRuns(ctx, req.query) }),
  route({ method: 'GET', path: '/agent-runs/:id', permission: 'agents:read', handler: (ctx, req) => svc.getRun(ctx, req.params.id) }),
  route({ method: 'POST', path: '/agent-runs/:id/control', permission: 'agents:run', body: z.object({ action: z.enum(['pause', 'resume', 'stop']) }), handler: (ctx, req) => svc.controlRun(ctx, req.params.id, req.body.action) }),

  route({ method: 'GET', path: '/agent-approvals', permission: 'agents:read', query: z.object({ status: z.enum(['pending', 'approved', 'rejected', 'expired']).optional() }), handler: (ctx, req) => svc.listApprovals(ctx, req.query) }),
  route({ method: 'POST', path: '/agent-approvals/:id/decide', permission: 'agents:approve', body: svc.DecisionInput, handler: (ctx, req) => svc.decide(ctx, req.params.id, req.body) }),

  route({ method: 'GET', path: '/agent-memories', permission: 'agents:read', query: z.object({ agentId: z.string().max(40).optional(), search: z.string().max(200).optional() }), handler: (ctx, req) => svc.listMemories(ctx, req.query) }),
  route({ method: 'POST', path: '/agent-memories', permission: 'agents:manage', body: svc.MemoryInput.extend({ agentId: z.uuid().nullable().optional() }), handler: (ctx, req) => svc.remember(ctx, req.body.agentId ?? null, { ...req.body, scope: req.body.agentId ? 'agent' : 'org' }) }),
  route({ method: 'PATCH', path: '/agent-memories/:id', permission: 'agents:manage', body: svc.MemoryPatch, handler: (ctx, req) => svc.updateMemory(ctx, req.params.id, req.body) }),
  route({ method: 'DELETE', path: '/agent-memories/:id', permission: 'agents:manage', handler: (ctx, req) => svc.deleteMemory(ctx, req.params.id) }),

  route({ method: 'GET', path: '/agent-usage', permission: 'agents:read', handler: (ctx) => svc.usage(ctx) }),
  route({ method: 'POST', path: '/agents-kill-switch', permission: 'agents:manage', body: z.object({ paused: z.boolean() }), handler: (ctx, req) => svc.setKillSwitch(ctx, req.body.paused) }),
]);
