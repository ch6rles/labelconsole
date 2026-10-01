import { z } from 'zod';
import { compact, defineTool } from '@labelconsole/core/tools';
import { CONTACT_TYPES } from '../schema';
import * as svc from '../service';

export const tools = [
  defineTool({
    name: 'network_find_contacts',
    module: 'network',
    description: 'Search the label network (creators, playlist editors, curators, press) by name or handle, type, genre and minimum audience. Contacts marked gone or do-not-contact are flagged; never pitch them.',
    input: z.object({ q: z.string().max(100).optional(), type: z.enum(CONTACT_TYPES).optional(), genre: z.string().max(40).optional(), minAudience: z.number().int().min(0).optional(), limit: z.number().int().min(1).max(50).default(20) }),
    permission: 'network:read',
    risk: 'read',
    idempotent: true,
    execute: (t, i) =>
      t.withOrg(async (ctx) => {
        const rows = await svc.listContacts(ctx, { q: i.q, type: i.type, genre: i.genre, minAudience: i.minAudience });
        return compact({ total: rows.length, contacts: rows.slice(0, i.limit).map(svc.contactForAgent) });
      }),
  }),
  defineTool({
    name: 'network_add_contact',
    module: 'network',
    description: 'Add a creator, editor, curator or press contact found during research. Fails with the existing contact if the email or a handle is already in the network.',
    input: z.object({
      type: z.enum(CONTACT_TYPES),
      name: z.string().min(1).max(200),
      email: z.email().optional(),
      organization: z.string().max(200).optional(),
      handles: z.object({ instagram: z.string(), tiktok: z.string(), youtube: z.string(), x: z.string(), spotify: z.string(), website: z.string() }).partial().default({}),
      audienceSize: z.number().int().min(0).optional(),
      genres: z.array(z.string()).max(10).default([]),
      notes: z.string().max(2000).optional(),
    }),
    permission: 'network:write',
    risk: 'write',
    preview: (i) => `Add ${i.type} "${i.name}"${i.audienceSize ? ` (${i.audienceSize.toLocaleString()} audience)` : ''} to the network`,
    execute: (t, i) => t.withOrg(async (ctx) => svc.contactForAgent(await svc.createContact(ctx, { ...i, notes: i.notes ? `${i.notes}\n(added by an agent)` : 'Added by an agent' }))),
  }),
  defineTool({
    name: 'network_log_interaction',
    module: 'network',
    description: 'Record a conversation or note with a contact (email, DM, call, meeting, note), optionally tied to a campaign. Logging does not send anything.',
    input: z.object({ contactId: z.uuid(), channel: z.enum(svc.INTERACTION_CHANNELS), direction: z.enum(['inbound', 'outbound']).default('outbound'), summary: z.string().min(1).max(3000), campaignId: z.uuid().optional() }),
    permission: 'network:write',
    risk: 'write',
    idempotent: false,
    execute: (t, i) => t.withOrg(async (ctx) => ({ id: (await svc.logInteraction(ctx, i.contactId, i)).id })),
  }),
];
