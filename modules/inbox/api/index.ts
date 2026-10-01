import { z } from 'zod';
import { defineRoutes, route } from '@labelconsole/core/router';
import * as svc from '../service';

export const routes = defineRoutes('inbox', [
  route({ method: 'GET', path: '/inbox/notifications', permission: null, query: svc.ListQuery, handler: (ctx, req) => svc.listNotifications(ctx, req.session.user.id, req.query) }),
  route({ method: 'POST', path: '/inbox/notifications/read', permission: null, body: z.object({ ids: z.array(z.uuid()).min(1).max(200) }), handler: (ctx, req) => svc.markRead(ctx, req.session.user.id, req.body.ids) }),
  route({ method: 'POST', path: '/inbox/notifications/read-all', permission: null, handler: (ctx, req) => svc.markRead(ctx, req.session.user.id) }),
  route({ method: 'GET', path: '/inbox/activity', permission: null, query: z.object({ limit: z.coerce.number().int().min(1).max(200).optional(), before: z.iso.datetime().optional() }), handler: (ctx, req) => svc.activity(ctx, req.query) }),
]);
