import { defineRoutes, route } from '@labelconsole/core/router';
import * as svc from '../service';

export const routes = defineRoutes('discord', [
  route({ method: 'GET', path: '/discord/me', permission: null, handler: (ctx) => svc.myLink(ctx) }),
  route({ method: 'POST', path: '/discord/link-code', permission: svc.USE_PERMISSION, handler: (ctx) => svc.createLinkCode(ctx) }),
  route({ method: 'GET', path: '/discord/links', permission: 'settings:read', handler: (ctx) => svc.listLinks(ctx) }),
  route({ method: 'DELETE', path: '/discord/links/:id', permission: null, handler: (ctx, req) => svc.removeLink(ctx, req.params.id) }),
  route({ method: 'GET', path: '/discord/status', permission: 'settings:read', handler: (ctx) => svc.discordStatus(ctx) }),
  route({ method: 'POST', path: '/discord/commands', permission: 'settings:manage', handler: (ctx) => svc.requestCommandRegistration(ctx) }),
  route({ method: 'GET', path: '/discord/sharing', permission: 'settings:read', handler: (ctx) => svc.sharingSettings(ctx) }),
  route({ method: 'PATCH', path: '/discord/sharing', permission: 'settings:manage', body: svc.SharingPatch, handler: (ctx, req) => svc.updateSharing(ctx, req.body) }),
  route({ method: 'GET', path: '/discord/corrections', permission: svc.USE_PERMISSION, handler: (ctx, req) => svc.listCorrections(ctx, req.query.status === 'reviewed' ? 'reviewed' : 'pending') }),
  route({ method: 'POST', path: '/discord/corrections/:id/review', permission: 'catalogue:write', body: svc.ReviewInput, handler: (ctx, req) => svc.reviewCorrection(ctx, req.params.id, req.body) }),
  route({ method: 'GET', path: '/discord/stats', permission: 'settings:read', handler: (ctx) => svc.lookupStats(ctx) }),
]);
