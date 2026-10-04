import { z } from 'zod';
import { defineRoutes, route } from '@labelconsole/core/router';
import * as svc from '../service';

export const routes = defineRoutes('streams', [
  // The internal API from the spec.
  route({ method: 'GET', path: '/streams/tracks/:id', permission: 'streams:read', query: svc.HistoryQuery, handler: (ctx, req) => svc.trackHistory(ctx, req.params.id, req.query) }),
  route({ method: 'GET', path: '/streams/artists/:id', permission: 'streams:read', query: svc.HistoryQuery, handler: (ctx, req) => svc.artistHistory(ctx, req.params.id, req.query) }),
  route({ method: 'GET', path: '/streams/movers', permission: 'streams:read', query: svc.MoversQuery, handler: (ctx, req) => svc.movers(ctx, req.query) }),
  route({ method: 'GET', path: '/streams/overview', permission: 'streams:read', handler: (ctx) => svc.overview(ctx) }),

  // Tracking registry.
  route({ method: 'GET', path: '/streams/registry', permission: 'streams:read', query: svc.TrackListQuery, handler: (ctx, req) => svc.listTracked(ctx, req.query) }),
  route({ method: 'GET', path: '/streams/registry/:trackId', permission: 'streams:read', handler: (ctx, req) => svc.getTracked(ctx, req.params.trackId) }),
  route({ method: 'POST', path: '/streams/registry/:trackId', permission: 'streams:manage', handler: async (ctx, req) => (await svc.registerTrack(ctx, req.params.trackId)) ?? { registered: false } }),
  route({ method: 'PATCH', path: '/streams/registry/:trackId', permission: 'streams:manage', body: z.object({ status: z.enum(['tracking', 'paused']) }), handler: (ctx, req) => svc.setTrackStatus(ctx, req.params.trackId, req.body.status) }),
  route({ method: 'POST', path: '/streams/poll', permission: 'streams:manage', body: z.object({ trackId: z.uuid().optional() }), handler: (ctx, req) => svc.requestPoll(ctx, req.body.trackId) }),
  route({ method: 'POST', path: '/streams/registry/:trackId/resolve', permission: 'streams:manage', handler: (ctx, req) => svc.requestResolve(ctx, req.params.trackId) }),
  route({ method: 'POST', path: '/streams/registry/:trackId/youtube', permission: 'streams:manage', body: svc.AddVideoInput, handler: (ctx, req) => svc.addVideo(ctx, req.params.trackId, req.body) }),
  route({ method: 'POST', path: '/streams/registry/:trackId/spotify', permission: 'streams:manage', body: svc.SpotifyTrackInput, handler: (ctx, req) => svc.setSpotifyTrack(ctx, req.params.trackId, req.body) }),

  // Matching review.
  route({ method: 'GET', path: '/streams/matching', permission: 'streams:manage', handler: (ctx) => svc.matchingQueue(ctx) }),
  route({ method: 'POST', path: '/streams/link-artists', permission: 'people:write', body: z.object({ artistIds: z.array(z.uuid()).max(500).optional() }), handler: (ctx, req) => svc.requestSpotifyArtistLink(ctx, req.body.artistIds) }),
  route({ method: 'POST', path: '/streams/matching/:id', permission: 'streams:manage', body: z.object({ status: z.enum(['confirmed', 'rejected']) }), handler: (ctx, req) => svc.reviewMatch(ctx, req.params.id, req.body.status) }),

  // Alerts and rules.
  route({ method: 'GET', path: '/streams/alerts', permission: 'streams:read', query: svc.AlertQuery, handler: (ctx, req) => svc.listAlerts(ctx, req.query) }),
  route({ method: 'POST', path: '/streams/alerts/:id/ack', permission: 'streams:read', handler: (ctx, req) => svc.acknowledgeAlert(ctx, req.params.id) }),
  route({ method: 'GET', path: '/streams/alert-rules', permission: 'streams:read', handler: (ctx) => svc.listRules(ctx) }),
  route({ method: 'POST', path: '/streams/alert-rules', permission: 'streams:manage', body: svc.RuleInput, handler: (ctx, req) => svc.createRule(ctx, req.body) }),
  route({ method: 'PATCH', path: '/streams/alert-rules/:id', permission: 'streams:manage', body: svc.RulePatch, handler: (ctx, req) => svc.updateRule(ctx, req.params.id, req.body) }),
  route({ method: 'DELETE', path: '/streams/alert-rules/:id', permission: 'streams:manage', handler: (ctx, req) => svc.deleteRule(ctx, req.params.id) }),
]);
