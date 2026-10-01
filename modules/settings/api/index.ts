import { z } from 'zod';
import { defineRoutes, route } from '@labelconsole/core/router';
import { storage } from '@labelconsole/core/storage';
import * as svc from '../service';

export const routes = defineRoutes('settings', [
  route({ method: 'GET', path: '/settings/workspace', permission: 'settings:read', handler: (ctx) => svc.getWorkspace(ctx) }),
  route({ method: 'PATCH', path: '/settings/workspace', permission: 'settings:manage', body: svc.WorkspacePatch, handler: (ctx, req) => svc.updateWorkspace(ctx, req.body) }),
  route({ method: 'POST', path: '/settings/onboarding', permission: 'settings:manage', body: z.object({ hidden: z.boolean() }), handler: (ctx, req) => svc.setOnboardingHidden(ctx, req.body.hidden) }),
  route({ method: 'PATCH', path: '/settings/profile', permission: null, body: svc.ProfilePatch, handler: (ctx, req) => svc.updateProfile(ctx, req.body) }),

  route({ method: 'GET', path: '/settings/members', permission: 'settings:read', handler: (ctx) => svc.listMembers(ctx) }),
  route({ method: 'POST', path: '/settings/invitations', permission: 'settings:members', body: svc.InviteInput, handler: (ctx, req) => svc.inviteMember(ctx, req.body) }),
  route({ method: 'DELETE', path: '/settings/invitations/:id', permission: 'settings:members', handler: (ctx, req) => svc.revokeInvitation(ctx, req.params.id) }),
  route({ method: 'PATCH', path: '/settings/members/:id', permission: 'settings:members', body: svc.RoleChange, handler: (ctx, req) => svc.changeRole(ctx, req.params.id, req.body) }),
  route({ method: 'DELETE', path: '/settings/members/:id', permission: 'settings:members', handler: (ctx, req) => svc.removeMember(ctx, req.params.id) }),

  route({ method: 'GET', path: '/settings/roles', permission: 'settings:read', handler: (ctx) => svc.rolesMatrix(ctx) }),
  route({ method: 'POST', path: '/settings/roles', permission: 'settings:members', body: svc.CustomRoleInput, handler: (ctx, req) => svc.createCustomRole(ctx, req.body) }),

  route({ method: 'GET', path: '/settings/audit', permission: 'settings:audit', query: svc.AuditQuery, handler: (ctx, req) => svc.listAudit(ctx, req.query) }),
  route({
    method: 'GET',
    path: '/settings/audit.csv',
    permission: 'settings:audit',
    query: svc.AuditQuery,
    handler: async (ctx, req) => {
      const rows = await svc.listAudit(ctx, { ...req.query, limit: 500 });
      const esc = (v: unknown) => `"${String(v ?? '').replace(/"/g, '""')}"`;
      const lines = [
        ['time', 'actor_type', 'actor', 'action', 'module', 'target_type', 'target', 'agent_run_id'].join(','),
        ...rows.map((r) => [r.createdAt.toISOString(), r.actorType, r.actorLabel, r.action, r.module, r.targetType, r.targetLabel, r.agentRunId].map(esc).join(',')),
      ];
      return new Response(lines.join('\n'), { headers: { 'content-type': 'text/csv; charset=utf-8', 'content-disposition': 'attachment; filename="audit-log.csv"' } });
    },
  }),

  route({ method: 'GET', path: '/settings/credentials', permission: 'settings:read', handler: (ctx) => svc.credentialsStatus(ctx) }),
  route({ method: 'POST', path: '/settings/credentials', permission: 'settings:credentials', body: svc.CredentialInput, handler: (ctx, req) => svc.saveCredential(ctx, req.body) }),
  route({ method: 'DELETE', path: '/settings/credentials/:id', permission: 'settings:credentials', handler: (ctx, req) => svc.revokeCredential(ctx, req.params.id) }),

  route({ method: 'GET', path: '/settings/modules', permission: 'settings:read', handler: (ctx) => svc.listModules(ctx) }),
  route({
    method: 'PATCH',
    path: '/settings/modules/:id',
    permission: 'settings:manage',
    body: z.object({ enabled: z.boolean() }),
    handler: (ctx, req) => svc.setModuleEnabled(ctx, req.params.id, req.body.enabled),
  }),
  route({ method: 'GET', path: '/settings/usage', permission: 'settings:read', handler: (ctx) => svc.planUsage(ctx) }),

  route({ method: 'POST', path: '/settings/exports', permission: 'settings:export', handler: (ctx) => svc.requestExport(ctx) }),
  route({ method: 'GET', path: '/settings/exports', permission: 'settings:export', handler: (ctx) => svc.listExports(ctx) }),
  route({
    method: 'GET',
    path: '/settings/exports/:id',
    permission: 'settings:export',
    handler: async (ctx, req) => {
      const row = await svc.getExport(ctx, req.params.id);
      const url = row.status === 'done' && row.storageKey ? await storage().signedUrl(row.storageKey, { expiresInSec: 300, filename: `label-export-${row.id}.ndjson` }) : null;
      return { ...row, url };
    },
  }),
  route({
    method: 'POST',
    path: '/settings/delete-label',
    permission: 'settings:billing',
    body: z.object({ confirm: z.string() }),
    handler: (ctx, req) => svc.requestDeletion(ctx, req.body.confirm),
  }),
]);
