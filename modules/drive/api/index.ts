import { z } from 'zod';
import { ValidationError } from '@labelconsole/core/errors';
import { defineRoutes, route } from '@labelconsole/core/router';
import * as svc from '../service';

export const routes = defineRoutes('drive', [
  route({
    method: 'GET',
    path: '/drive/folders',
    permission: 'drive:read',
    query: z.object({ folderId: z.uuid().optional(), q: z.string().max(100).optional() }),
    handler: (ctx, req) => svc.listFolder(ctx, req.query.folderId ?? null, { q: req.query.q }),
  }),
  route({ method: 'POST', path: '/drive/folders', permission: 'drive:write', body: svc.FolderInput, handler: (ctx, req) => svc.createFolder(ctx, req.body) }),
  route({ method: 'PATCH', path: '/drive/folders/:id', permission: 'drive:write', body: z.object({ name: z.string().trim().min(1).max(200) }), handler: (ctx, req) => svc.renameFolder(ctx, req.params.id, req.body.name) }),
  route({ method: 'DELETE', path: '/drive/folders/:id', permission: 'drive:delete', handler: (ctx, req) => svc.deleteFolder(ctx, req.params.id) }),
  route({ method: 'POST', path: '/drive/folders/:id/sync', permission: 'drive:manage', handler: (ctx, req) => svc.requestSync(ctx, req.params.id) }),
  route({ method: 'GET', path: '/drive/folders/:id/permissions', permission: 'drive:read', handler: (ctx, req) => svc.listGrants(ctx, req.params.id) }),
  route({ method: 'PUT', path: '/drive/folders/:id/permissions', permission: 'drive:manage', body: svc.GrantInput, handler: (ctx, req) => svc.setGrant(ctx, req.params.id, req.body) }),
  route({ method: 'DELETE', path: '/drive/permissions/:id', permission: 'drive:manage', handler: (ctx, req) => svc.removeGrant(ctx, req.params.id) }),
  route({ method: 'POST', path: '/drive/google/connect', permission: 'drive:manage', body: svc.ConnectInput, handler: (ctx, req) => svc.connectGoogleFolder(ctx, req.body) }),

  route({
    method: 'POST',
    path: '/drive/files',
    permission: 'drive:write',
    multipart: true,
    handler: async (ctx, req) => {
      const file = req.form?.get('file');
      if (!(file instanceof File)) throw new ValidationError('Choose a file to upload');
      const folderId = (req.form?.get('folderId') as string | null) || null;
      const row = await svc.storeFile(ctx, { name: file.name, mime: file.type, body: file.stream(), folderId, confidential: req.form?.get('confidential') === 'true' });
      const entityType = req.form?.get('entityType') as string | null;
      const entityId = req.form?.get('entityId') as string | null;
      if (entityType && entityId) await svc.linkFile(ctx, row.id, entityType, entityId);
      return row;
    },
  }),
  route({
    method: 'GET',
    path: '/drive/files/:id',
    permission: 'drive:read',
    handler: async (ctx, req) => {
      const file = await svc.getFile(ctx, req.params.id);
      return { ...file, url: file.status === 'quarantined' ? null : await svc.downloadUrl(ctx, file.id, { inline: true }) };
    },
  }),
  route({
    method: 'GET',
    path: '/drive/files/:id/download',
    permission: 'drive:read',
    query: z.object({ inline: z.enum(['1', '0']).optional() }),
    handler: async (ctx, req) => Response.redirect(await svc.downloadUrl(ctx, req.params.id, { inline: req.query.inline === '1' }), 302),
  }),
  route({ method: 'PATCH', path: '/drive/files/:id', permission: 'drive:write', body: svc.FilePatch, handler: (ctx, req) => svc.updateFile(ctx, req.params.id, req.body) }),
  route({ method: 'DELETE', path: '/drive/files/:id', permission: 'drive:delete', handler: (ctx, req) => svc.deleteFile(ctx, req.params.id) }),
  route({
    method: 'POST',
    path: '/drive/files/:id/links',
    permission: 'drive:write',
    body: z.object({ entityType: z.string().min(1).max(40), entityId: z.uuid() }),
    handler: (ctx, req) => svc.linkFile(ctx, req.params.id, req.body.entityType, req.body.entityId),
  }),
  route({
    method: 'DELETE',
    path: '/drive/files/:id/links/:entityType/:entityId',
    permission: 'drive:write',
    handler: (ctx, req) => svc.unlinkFile(ctx, req.params.id, req.params.entityType, req.params.entityId),
  }),
]);
