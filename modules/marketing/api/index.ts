import { z } from 'zod';
import { defineRoutes, route } from '@labelconsole/core/router';
import * as svc from '../service';

export const routes = defineRoutes('marketing', [
  route({ method: 'GET', path: '/marketing/overview', permission: 'marketing:read', handler: (ctx) => svc.marketingOverview(ctx) }),
  route({ method: 'GET', path: '/marketing/bookings.csv', permission: 'marketing:read', handler: async (ctx) => new Response(await svc.bookingsCsv(ctx), { headers: { 'content-type': 'text/csv; charset=utf-8', 'content-disposition': `attachment; filename="bookings-${new Date().toISOString().slice(0, 10)}.csv"` } }) }),

  // Campaigns
  route({ method: 'GET', path: '/marketing/campaigns', permission: 'marketing:read', query: svc.CampaignQuery, handler: (ctx, req) => svc.listCampaigns(ctx, req.query) }),
  route({ method: 'POST', path: '/marketing/campaigns', permission: 'marketing:write', body: svc.CampaignInput, handler: (ctx, req) => svc.createCampaign(ctx, req.body) }),
  route({ method: 'GET', path: '/marketing/campaigns/:id', permission: 'marketing:read', handler: (ctx, req) => svc.getCampaign(ctx, req.params.id) }),
  route({ method: 'PATCH', path: '/marketing/campaigns/:id', permission: 'marketing:write', body: svc.CampaignPatch, handler: (ctx, req) => svc.updateCampaign(ctx, req.params.id, req.body) }),
  route({ method: 'DELETE', path: '/marketing/campaigns/:id', permission: 'marketing:delete', handler: (ctx, req) => svc.deleteCampaign(ctx, req.params.id) }),

  // Pipelines
  route({ method: 'GET', path: '/marketing/boards', permission: 'marketing:read', handler: (ctx) => svc.listBoards(ctx) }),
  route({ method: 'POST', path: '/marketing/boards', permission: 'marketing:write', body: svc.BoardInput, handler: (ctx, req) => svc.createBoard(ctx, req.body) }),
  route({ method: 'GET', path: '/marketing/boards/:id', permission: 'marketing:read', handler: (ctx, req) => svc.getBoard(ctx, req.params.id) }),
  route({ method: 'PATCH', path: '/marketing/boards/:id', permission: 'marketing:write', body: z.object({ name: z.string().max(200).optional(), stages: z.array(z.object({ id: z.string(), name: z.string() })).optional() }), handler: (ctx, req) => svc.updateBoard(ctx, req.params.id, req.body) }),
  route({ method: 'DELETE', path: '/marketing/boards/:id', permission: 'marketing:delete', handler: (ctx, req) => svc.deleteBoard(ctx, req.params.id) }),
  route({ method: 'POST', path: '/marketing/cards', permission: 'marketing:write', body: svc.CardInput, handler: (ctx, req) => svc.createCard(ctx, req.body) }),
  route({ method: 'PATCH', path: '/marketing/cards/:id', permission: 'marketing:write', body: svc.CardPatch, handler: (ctx, req) => svc.updateCard(ctx, req.params.id, req.body) }),
  route({ method: 'PATCH', path: '/marketing/cards/:id/move', permission: 'marketing:write', body: svc.MoveInput, handler: (ctx, req) => svc.moveCard(ctx, req.params.id, req.body) }),
  route({ method: 'DELETE', path: '/marketing/cards/:id', permission: 'marketing:write', handler: (ctx, req) => svc.deleteCard(ctx, req.params.id) }),

  // Outreach
  route({ method: 'GET', path: '/marketing/pitches', permission: 'marketing:read', query: svc.PitchQuery, handler: (ctx, req) => svc.listPitches(ctx, req.query) }),
  route({ method: 'POST', path: '/marketing/pitches', permission: 'marketing:write', body: svc.PitchInput, handler: (ctx, req) => svc.createPitch(ctx, req.body) }),
  route({ method: 'PATCH', path: '/marketing/pitches/:id', permission: 'marketing:write', body: svc.PitchPatch, handler: (ctx, req) => svc.updatePitch(ctx, req.params.id, req.body) }),
  route({ method: 'POST', path: '/marketing/pitches/:id/send', permission: 'marketing:write', handler: (ctx, req) => svc.sendPitch(ctx, req.params.id) }),
  route({ method: 'POST', path: '/marketing/pitches/:id/outcome', permission: 'marketing:write', body: svc.OutcomeInput, handler: (ctx, req) => svc.setPitchOutcome(ctx, req.params.id, req.body) }),
  route({ method: 'DELETE', path: '/marketing/pitches/:id', permission: 'marketing:write', handler: (ctx, req) => svc.deletePitch(ctx, req.params.id) }),

  // Sketchboards
  route({ method: 'GET', path: '/marketing/sketchboards', permission: 'marketing:read', handler: (ctx) => svc.listSketchboards(ctx) }),
  route({ method: 'POST', path: '/marketing/sketchboards', permission: 'marketing:write', body: svc.SketchboardInput, handler: (ctx, req) => svc.createSketchboard(ctx, req.body) }),
  route({ method: 'GET', path: '/marketing/sketchboards/:id', permission: 'marketing:read', handler: (ctx, req) => svc.getSketchboard(ctx, req.params.id) }),
  route({ method: 'PUT', path: '/marketing/sketchboards/:id/canvas', permission: 'marketing:write', body: svc.CanvasInput, handler: (ctx, req) => svc.saveCanvas(ctx, req.params.id, req.body) }),
  route({ method: 'PATCH', path: '/marketing/sketchboards/:id', permission: 'marketing:write', body: svc.SketchboardInput.partial(), handler: (ctx, req) => svc.renameSketchboard(ctx, req.params.id, req.body) }),
  route({ method: 'DELETE', path: '/marketing/sketchboards/:id', permission: 'marketing:delete', handler: (ctx, req) => svc.deleteSketchboard(ctx, req.params.id) }),
]);
