import { z } from 'zod';
import { defineTool } from '@labelconsole/core/tools';
import { ARTIST_STATUSES } from '../schema';
import * as svc from '../service';

const summary = (a: Awaited<ReturnType<typeof svc.getArtist>>) => ({
  id: a.id,
  name: a.name,
  aliases: a.aliases,
  status: a.status,
  country: a.country,
  manager: a.manager,
  socials: a.socials,
  rosterSince: a.rosterSince,
  onboarding: a.status === 'onboarding' ? { ...svc.onboardingProgress(a.onboarding), next: svc.nextStepFor(a) } : undefined,
  notes: a.notes,
});

export const tools = [
  defineTool({
    name: 'people_get_artist',
    module: 'people',
    description: 'Get one artist on the roster by id or exact name: status, country, management, socials, onboarding progress and notes.',
    input: z.object({ id: z.uuid().optional(), name: z.string().optional() }),
    permission: 'people:read',
    risk: 'read',
    idempotent: true,
    execute: (t, i) =>
      t.withOrg(async (ctx) => {
        if (i.id) return summary(await svc.getArtist(ctx, i.id));
        const found = i.name ? await svc.findArtistByName(ctx, i.name) : null;
        return found ? summary(found) : { found: false };
      }),
  }),
  defineTool({
    name: 'people_list_roster',
    module: 'people',
    description: 'List artists on the roster, optionally filtered by status (prospect, onboarding, active, paused, alumni) or a name search.',
    input: z.object({ status: z.enum(ARTIST_STATUSES).optional(), q: z.string().max(100).optional() }),
    permission: 'people:read',
    risk: 'read',
    idempotent: true,
    execute: (t, i) => t.withOrg(async (ctx) => (await svc.listArtists(ctx, { status: i.status, q: i.q, limit: 100 })).map((a) => ({ id: a.id, name: a.name, status: a.status, country: a.country }))),
  }),
  defineTool({
    name: 'people_update_artist_status',
    module: 'people',
    description: "Change an artist's roster status. Always needs a person to approve.",
    input: z.object({ id: z.uuid(), status: z.enum(ARTIST_STATUSES), reason: z.string().max(500) }),
    permission: 'people:write',
    risk: 'write',
    requiresApproval: true,
    preview: (i) => `Set artist ${i.id} to "${i.status}": ${i.reason}`,
    execute: (t, i) => t.withOrg(async (ctx) => summary(await svc.updateArtist(ctx, i.id, { status: i.status }))),
  }),
];
