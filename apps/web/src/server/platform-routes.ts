import 'server-only';
import { enabledModuleIds, modules, type SearchResult } from '@labelconsole/core/modules';
import { defineRoutes, route } from '@labelconsole/core/router';
import { z } from 'zod';

/** Cross-module endpoints owned by the platform (registered under the core settings module). */
export const platformRoutes = defineRoutes('settings', [
  route({
    method: 'GET',
    path: '/search',
    permission: null,
    query: z.object({ q: z.string().trim().min(1).max(100) }),
    handler: async (ctx, req) => {
      const enabled = await enabledModuleIds(ctx.tx, req.session.org);
      const results: SearchResult[] = [];
      for (const m of modules()) {
        if (!m.search || !enabled.has(m.manifest.id)) continue;
        try {
          results.push(...(await m.search(ctx, req.query.q)));
        } catch {
          /* a module without the reader's permission simply contributes nothing */
        }
      }
      return { results: results.slice(0, 30) };
    },
  }),
  route({
    method: 'GET',
    path: '/me',
    permission: null,
    handler: async (_ctx, req) => ({
      user: req.session.user,
      org: { id: req.session.org.id, name: req.session.org.name, plan: req.session.org.plan },
      role: req.session.membership.role,
      permissions: req.session.permissions.toArray(),
    }),
  }),
]);
