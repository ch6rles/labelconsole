import { z } from 'zod';
import { defineRoutes, route } from '@labelconsole/core/router';
import * as svc from '../service';

export const routes = defineRoutes('network', [
  route({ method: 'GET', path: '/network/contacts', permission: 'network:read', query: svc.ContactQuery, handler: (ctx, req) => svc.listContacts(ctx, req.query) }),
  route({ method: 'POST', path: '/network/contacts', permission: 'network:write', body: svc.ContactInput, handler: (ctx, req) => svc.createContact(ctx, req.body) }),
  route({ method: 'GET', path: '/network/contacts/:id', permission: 'network:read', handler: (ctx, req) => svc.getContact(ctx, req.params.id) }),
  route({ method: 'PATCH', path: '/network/contacts/:id', permission: 'network:write', body: svc.ContactPatch, handler: (ctx, req) => svc.updateContact(ctx, req.params.id, req.body) }),
  route({ method: 'DELETE', path: '/network/contacts/:id', permission: 'network:delete', handler: (ctx, req) => svc.deleteContact(ctx, req.params.id) }),
  route({ method: 'POST', path: '/network/contacts/:id/account', permission: 'network:write', body: z.object({ state: z.enum(['verified', 'gone', 'unverified']) }), handler: (ctx, req) => svc.setAccountState(ctx, req.params.id, req.body.state) }),
  route({ method: 'POST', path: '/network/contacts/:id/interactions', permission: 'network:write', body: svc.InteractionInput, handler: (ctx, req) => svc.logInteraction(ctx, req.params.id, req.body) }),
  route({ method: 'GET', path: '/network/playlists', permission: 'network:read', query: z.object({ q: z.string().max(100).optional(), platform: z.string().max(30).optional(), genre: z.string().max(40).optional() }), handler: (ctx, req) => svc.listPlaylists(ctx, req.query) }),
  route({ method: 'POST', path: '/network/playlists', permission: 'network:write', body: svc.PlaylistInput, handler: (ctx, req) => svc.createPlaylist(ctx, req.body) }),
  route({ method: 'POST', path: '/network/playlists/refresh', permission: 'network:write', handler: (ctx) => svc.requestPlaylistRefresh(ctx) }),
  route({ method: 'PATCH', path: '/network/playlists/:id', permission: 'network:write', body: svc.PlaylistPatch, handler: (ctx, req) => svc.updatePlaylist(ctx, req.params.id, req.body) }),
  route({ method: 'DELETE', path: '/network/playlists/:id', permission: 'network:delete', handler: (ctx, req) => svc.deletePlaylist(ctx, req.params.id) }),
]);
