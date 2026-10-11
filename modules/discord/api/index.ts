import { defineRoutes, route } from '@labelconsole/core/router';
import * as svc from '../service';

export const routes = defineRoutes('discord', [
  route({ method: 'GET', path: '/discord/me', permission: null, handler: (ctx) => svc.myLink(ctx) }),
  route({ method: 'POST', path: '/discord/link-code', permission: svc.USE_PERMISSION, handler: (ctx) => svc.createLinkCode(ctx) }),
  route({ method: 'GET', path: '/discord/links', permission: 'settings:read', handler: (ctx) => svc.listLinks(ctx) }),
  route({ method: 'DELETE', path: '/discord/links/:id', permission: null, handler: (ctx, req) => svc.removeLink(ctx, req.params.id) }),
  route({ method: 'GET', path: '/discord/status', permission: 'settings:read', handler: (ctx) => svc.discordStatus(ctx) }),
  route({ method: 'POST', path: '/discord/commands', permission: 'settings:manage', handler: (ctx) => svc.requestCommandRegistration(ctx) }),
]);
