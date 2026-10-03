import { z } from 'zod';
import { ValidationError } from '@labelconsole/core/errors';
import { defineRoutes, route } from '@labelconsole/core/router';
import { storeFile, ensureSystemFolder, linkFile } from '@labelconsole/drive/service';
import { DEMO_STAGES } from '../schema';
import * as svc from '../service';

export const routes = defineRoutes('catalogue', [
  /* releases */
  route({ method: 'GET', path: '/catalogue/releases', permission: 'catalogue:read', query: svc.ListReleasesQuery, handler: (ctx, req) => svc.listReleases(ctx, req.query) }),
  route({ method: 'POST', path: '/catalogue/releases', permission: 'catalogue:write', body: svc.ReleaseInput, handler: (ctx, req) => svc.createRelease(ctx, req.body) }),
  route({ method: 'GET', path: '/catalogue/releases/:id', permission: 'catalogue:read', handler: (ctx, req) => svc.getRelease(ctx, req.params.id) }),
  route({ method: 'PATCH', path: '/catalogue/releases/:id', permission: 'catalogue:write', body: svc.ReleasePatch, handler: (ctx, req) => svc.updateRelease(ctx, req.params.id, req.body) }),
  route({ method: 'DELETE', path: '/catalogue/releases/:id', permission: 'catalogue:delete', handler: (ctx, req) => svc.deleteRelease(ctx, req.params.id) }),
  route({
    method: 'PATCH',
    path: '/catalogue/releases/:id/checklist',
    permission: 'catalogue:write',
    body: z.object({ itemId: z.string().min(1).max(60), done: z.boolean().optional(), label: z.string().max(120).optional(), remove: z.boolean().optional() }),
    handler: (ctx, req) => svc.setChecklistItem(ctx, req.params.id, req.body),
  }),
  route({ method: 'PUT', path: '/catalogue/releases/:id/tracks/order', permission: 'catalogue:write', body: z.object({ trackIds: z.array(z.uuid()) }), handler: (ctx, req) => svc.reorderTracks(ctx, req.params.id, req.body.trackIds) }),
  route({ method: 'POST', path: '/catalogue/releases/:id/tracks/:trackId', permission: 'catalogue:write', handler: (ctx, req) => svc.linkTrack(ctx, req.params.id, req.params.trackId) }),
  route({ method: 'DELETE', path: '/catalogue/releases/:id/tracks/:trackId', permission: 'catalogue:write', handler: (ctx, req) => svc.unlinkTrack(ctx, req.params.id, req.params.trackId) }),
  route({
    method: 'POST',
    path: '/catalogue/releases/:id/artwork',
    permission: 'catalogue:write',
    multipart: true,
    handler: async (ctx, req) => {
      const file = req.form?.get('file');
      if (!(file instanceof File)) throw new ValidationError('Choose an image');
      const folder = await ensureSystemFolder(ctx, 'Artwork');
      const stored = await storeFile(ctx, { name: file.name, mime: file.type, body: file.stream(), folderId: folder.id, kind: 'image' });
      await linkFile(ctx, stored.id, 'release', req.params.id);
      return svc.updateRelease(ctx, req.params.id, { artworkFileId: stored.id });
    },
  }),

  /* tracks */
  route({ method: 'GET', path: '/catalogue/tracks', permission: 'catalogue:read', query: svc.ListTracksQuery, handler: (ctx, req) => svc.listTracks(ctx, req.query) }),
  route({ method: 'POST', path: '/catalogue/tracks', permission: 'catalogue:write', body: svc.TrackInput, handler: (ctx, req) => svc.createTrack(ctx, req.body) }),
  route({ method: 'GET', path: '/catalogue/tracks/:id', permission: 'catalogue:read', handler: (ctx, req) => svc.getTrack(ctx, req.params.id) }),
  route({ method: 'PATCH', path: '/catalogue/tracks/:id', permission: 'catalogue:write', body: svc.TrackPatch, handler: (ctx, req) => svc.updateTrack(ctx, req.params.id, req.body) }),
  route({ method: 'DELETE', path: '/catalogue/tracks/:id', permission: 'catalogue:delete', handler: (ctx, req) => svc.deleteTrack(ctx, req.params.id) }),
  route({
    method: 'POST',
    path: '/catalogue/tracks/:id/audio',
    permission: 'catalogue:write',
    multipart: true,
    handler: async (ctx, req) => {
      const file = req.form?.get('file');
      if (!(file instanceof File)) throw new ValidationError('Choose an audio file');
      const folder = await ensureSystemFolder(ctx, 'Masters');
      const stored = await storeFile(ctx, { name: file.name, mime: file.type, body: file.stream(), folderId: folder.id, kind: 'audio' });
      await linkFile(ctx, stored.id, 'track', req.params.id);
      return svc.updateTrack(ctx, req.params.id, { audioFileId: stored.id });
    },
  }),
  route({ method: 'POST', path: '/catalogue/tracks/:id/credits', permission: 'catalogue:write', body: svc.CreditInput, handler: (ctx, req) => svc.addCredit(ctx, req.params.id, req.body) }),
  route({ method: 'DELETE', path: '/catalogue/credits/:id', permission: 'catalogue:write', handler: (ctx, req) => svc.removeCredit(ctx, req.params.id) }),
  route({ method: 'PUT', path: '/catalogue/tracks/:id/splits', permission: 'catalogue:write', body: svc.SplitSheetInput, handler: (ctx, req) => svc.saveSplitSheet(ctx, req.params.id, req.body) }),
  route({ method: 'PATCH', path: '/catalogue/split-parties/:id', permission: 'catalogue:write', body: z.object({ signed: z.boolean() }), handler: (ctx, req) => svc.setPartySigned(ctx, req.params.id, req.body.signed) }),
  route({ method: 'GET', path: '/catalogue/splits', permission: 'catalogue:read', handler: (ctx) => svc.listSplitSheets(ctx) }),

  /* identities */
  route({ method: 'POST', path: '/catalogue/tracks/:id/credits/import', permission: 'catalogue:write', handler: (ctx, req) => svc.requestCreditImport(ctx, [req.params.id]) }),
  route({ method: 'POST', path: '/catalogue/credits/import', permission: 'catalogue:write', handler: (ctx) => svc.requestCreditImport(ctx) }),
  route({ method: 'POST', path: '/catalogue/identities', permission: 'catalogue:write', body: svc.IdentityInput, handler: (ctx, req) => svc.upsertIdentity(ctx, req.body) }),
  route({ method: 'PATCH', path: '/catalogue/identities/:id', permission: 'catalogue:write', body: z.object({ status: z.enum(['confirmed', 'rejected']) }), handler: (ctx, req) => svc.reviewIdentity(ctx, req.params.id, req.body.status) }),

  /* demos */
  route({ method: 'GET', path: '/catalogue/demos', permission: 'catalogue:read', query: z.object({ stage: z.enum(DEMO_STAGES).optional() }), handler: (ctx, req) => svc.listDemos(ctx, req.query) }),
  route({
    method: 'POST',
    path: '/catalogue/demos',
    permission: 'catalogue:write',
    multipart: true,
    handler: async (ctx, req) => {
      const f = req.form!;
      const audio = f.get('audio');
      let audioFileId: string | null = null;
      if (audio instanceof File && audio.size > 0) {
        const folder = await ensureSystemFolder(ctx, 'Demos');
        audioFileId = (await storeFile(ctx, { name: audio.name, mime: audio.type, body: audio.stream(), folderId: folder.id, kind: 'audio' })).id;
      }
      const links = String(f.get('links') ?? '').trim();
      return svc.createDemo(ctx, {
        title: String(f.get('title') ?? ''),
        artistName: String(f.get('artistName') ?? ''),
        submitterName: (f.get('submitterName') as string) || null,
        submitterEmail: (f.get('submitterEmail') as string) || null,
        genre: (f.get('genre') as string) || null,
        notes: (f.get('notes') as string) || null,
        links: links ? (links.startsWith('[') ? JSON.parse(links) : links.split(/[\s,]+/).filter(Boolean)) : [],
        audioFileId,
      });
    },
  }),
  route({ method: 'PATCH', path: '/catalogue/demos/:id', permission: 'catalogue:write', body: z.object({ stage: z.enum(DEMO_STAGES) }), handler: (ctx, req) => svc.setDemoStage(ctx, req.params.id, req.body.stage) }),
  route({ method: 'POST', path: '/catalogue/demos/:id/score', permission: 'catalogue:write', body: svc.ScoreInput, handler: (ctx, req) => svc.scoreDemo(ctx, req.params.id, req.body) }),
  route({ method: 'DELETE', path: '/catalogue/demos/:id', permission: 'catalogue:delete', handler: (ctx, req) => svc.deleteDemo(ctx, req.params.id) }),
  route({ method: 'GET', path: '/catalogue/intake-link', permission: 'catalogue:read', handler: async (ctx) => ({ token: await svc.intakeToken(ctx) }) }),

  /* metadata lookup and import (the spec's POST /v1/metadata/resolve) */
  route({ method: 'POST', path: '/metadata/resolve', permission: 'catalogue:write', body: svc.LookupInput, status: 202, handler: (ctx, req) => svc.createLookup(ctx, req.body) }),
  route({ method: 'GET', path: '/metadata/resolve/:id', permission: 'catalogue:read', handler: (ctx, req) => svc.getLookup(ctx, req.params.id) }),
  route({ method: 'POST', path: '/metadata/resolve/:id/confirm', permission: 'catalogue:write', body: svc.ConfirmInput, handler: (ctx, req) => svc.confirmLookup(ctx, req.params.id, req.body) }),
  route({
    method: 'POST',
    path: '/metadata/resolve-file',
    permission: 'catalogue:write',
    multipart: true,
    status: 202,
    handler: async (ctx, req) => {
      const file = req.form?.get('file');
      if (!(file instanceof File)) throw new ValidationError('Choose an audio file');
      const folder = await ensureSystemFolder(ctx, 'Masters');
      const stored = await storeFile(ctx, { name: file.name, mime: file.type, body: file.stream(), folderId: folder.id, kind: 'audio' });
      return svc.createLookup(ctx, { fileId: stored.id });
    },
  }),
  route({
    method: 'POST',
    path: '/metadata/imports',
    permission: 'catalogue:write',
    multipart: true,
    status: 202,
    handler: async (ctx, req) => {
      const file = req.form?.get('file');
      const csv = file instanceof File ? await file.text() : String(req.form?.get('csv') ?? '');
      return svc.createBulkImport(ctx, svc.BulkInput.parse({ csv, autoConfirm: req.form?.get('autoConfirm') === 'true' }));
    },
  }),
  route({ method: 'GET', path: '/metadata/imports/:id', permission: 'catalogue:read', handler: (ctx, req) => svc.getImport(ctx, req.params.id) }),
  route({ method: 'POST', path: '/catalogue/artists/:id/spotify-sync', permission: 'catalogue:write', body: svc.SpotifySyncInput, status: 202, handler: (ctx, req) => svc.requestSpotifySync(ctx, req.params.id, req.body) }),
]);
