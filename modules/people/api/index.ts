import { defineRoutes, route } from '@labelconsole/core/router';
import * as svc from '../service';

export const routes = defineRoutes('people', [
  route({ method: 'GET', path: '/people/artists', permission: 'people:read', query: svc.ListQuery, handler: (ctx, req) => svc.listArtists(ctx, req.query) }),
  route({ method: 'POST', path: '/people/artists', permission: 'people:write', body: svc.ArtistInput, handler: (ctx, req) => svc.createArtist(ctx, req.body) }),
  route({ method: 'GET', path: '/people/artists/:id', permission: 'people:read', handler: (ctx, req) => svc.getArtist(ctx, req.params.id) }),
  route({ method: 'PATCH', path: '/people/artists/:id', permission: 'people:write', body: svc.ArtistPatch, handler: (ctx, req) => svc.updateArtist(ctx, req.params.id, req.body) }),
  route({ method: 'DELETE', path: '/people/artists/:id', permission: 'people:delete', handler: (ctx, req) => svc.deleteArtist(ctx, req.params.id) }),
  route({ method: 'PATCH', path: '/people/artists/:id/onboarding', permission: 'people:write', body: svc.OnboardingPatch, handler: (ctx, req) => svc.updateOnboarding(ctx, req.params.id, req.body) }),
  route({ method: 'GET', path: '/people/staff', permission: 'people:read', handler: (ctx) => svc.listStaff(ctx) }),
  route({ method: 'PATCH', path: '/people/staff/:userId', permission: null, body: svc.StaffPatch, handler: (ctx, req) => svc.upsertStaffProfile(ctx, req.params.userId, req.body) }),
]);
