import { z } from 'zod';
import { ValidationError } from '@labelconsole/core/errors';
import { defineRoutes, route } from '@labelconsole/core/router';
import { CONTRACT_STATUSES, DOCUMENT_TYPES } from '../schema';
import * as svc from '../service';

function metaFromForm(form: FormData) {
  const links = form.get('links');
  return {
    type: (form.get('type') as (typeof DOCUMENT_TYPES)[number]) || 'other',
    title: (form.get('title') as string) || undefined,
    tags: String(form.get('tags') ?? '').replace(/^\[|\]$/g, '').split(',').map((s) => s.replace(/"/g, '').trim()).filter(Boolean),
    confidential: form.get('confidential') === 'true',
    contractStatus: (form.get('contractStatus') as (typeof CONTRACT_STATUSES)[number]) || null,
    links: links ? JSON.parse(String(links)) : form.get('entityType') && form.get('entityId') ? [{ entityType: form.get('entityType'), entityId: form.get('entityId') }] : [],
  };
}

export const routes = defineRoutes('documents', [
  route({ method: 'GET', path: '/documents', permission: 'documents:read', query: svc.ListQuery, handler: (ctx, req) => svc.listDocuments(ctx, req.query) }),
  route({
    method: 'POST',
    path: '/documents',
    permission: 'documents:write',
    multipart: true,
    handler: async (ctx, req) => {
      const file = req.form?.get('file');
      if (!(file instanceof File)) throw new ValidationError('Choose a file');
      return svc.uploadDocument(ctx, { name: file.name, mime: file.type, body: file.stream() }, metaFromForm(req.form!));
    },
  }),
  route({ method: 'GET', path: '/documents/:id', permission: 'documents:read', handler: (ctx, req) => svc.getDocument(ctx, req.params.id) }),
  route({ method: 'PATCH', path: '/documents/:id', permission: 'documents:write', body: svc.DocumentPatch, handler: (ctx, req) => svc.updateDocument(ctx, req.params.id, req.body) }),
  route({ method: 'DELETE', path: '/documents/:id', permission: 'documents:delete', handler: (ctx, req) => svc.deleteDocument(ctx, req.params.id) }),
  route({
    method: 'POST',
    path: '/documents/:id/versions',
    permission: 'documents:write',
    multipart: true,
    handler: async (ctx, req) => {
      const file = req.form?.get('file');
      if (!(file instanceof File)) throw new ValidationError('Choose a file');
      return svc.uploadVersion(ctx, req.params.id, { name: file.name, mime: file.type, body: file.stream() });
    },
  }),
  route({ method: 'GET', path: '/documents/:id/download', permission: 'documents:read', query: z.object({ inline: z.enum(['1', '0']).optional() }), handler: async (ctx, req) => Response.redirect(await svc.documentDownloadUrl(ctx, req.params.id, req.query.inline === '1'), 302) }),
  route({ method: 'POST', path: '/documents/:id/extract', permission: 'documents:write', handler: (ctx, req) => svc.requestExtraction(ctx, req.params.id) }),
  route({ method: 'POST', path: '/documents/:id/confirm-terms', permission: 'documents:write', body: svc.TermsInput, handler: (ctx, req) => svc.confirmTerms(ctx, req.params.id, req.body) }),
  route({ method: 'POST', path: '/documents/:id/links', permission: 'documents:write', body: svc.LinkInput, handler: (ctx, req) => svc.linkDocument(ctx, req.params.id, req.body) }),
  route({ method: 'DELETE', path: '/documents/:id/links/:entityType/:entityId', permission: 'documents:write', handler: (ctx, req) => svc.unlinkDocument(ctx, req.params.id, svc.LinkInput.parse(req.params)) }),
  route({ method: 'GET', path: '/documents/:id/access-log', permission: 'documents:read', handler: (ctx, req) => svc.accessLog(ctx, req.params.id) }),
  route({ method: 'GET', path: '/documents-key-dates', permission: 'documents:read', handler: (ctx) => svc.upcomingKeyDates(ctx) }),
  route({ method: 'POST', path: '/documents-key-dates/:id/dismiss', permission: 'documents:write', handler: (ctx, req) => svc.dismissKeyDate(ctx, req.params.id) }),
  route({ method: 'GET', path: '/finance/royalties', permission: 'documents:read_financial', query: z.object({ months: z.coerce.number().int().min(1).max(36).default(12) }), handler: (ctx, req) => svc.royalties(ctx, req.query.months) }),
  route({ method: 'GET', path: '/finance/statements', permission: 'documents:read_financial', handler: (ctx) => svc.listStatements(ctx) }),
  route({ method: 'GET', path: '/finance/statements/:id/lines', permission: 'documents:read_financial', handler: (ctx, req) => svc.statementLinesFor(ctx, req.params.id) }),
]);
