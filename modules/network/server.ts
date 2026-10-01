import './types';
import { ilike, or, sql } from 'drizzle-orm';
import { defineModule } from '@labelconsole/core/modules';
import { tools } from './agent-tools';
import { routes } from './api';
import { manifest } from './manifest';
import { contacts } from './schema';
import * as svc from './service';

export default defineModule({
  manifest,
  routes,
  tools,
  stats: async (ctx) => {
    if (!ctx.can('network:read')) return [];
    const c = await svc.networkCounts(ctx);
    return [{ label: 'CREATOR NETWORK', icon: 'group', value: String(c.creators), note: `${c.total} contacts in all`, group: 'marketing' }];
  },
  search: async (ctx, q) => {
    if (!ctx.can('network:read')) return [];
    const rows = await ctx.tx
      .select({ id: contacts.id, name: contacts.name, type: contacts.type, organization: contacts.organization })
      .from(contacts)
      .where(or(ilike(contacts.name, `%${q}%`), ilike(contacts.organization, `%${q}%`), sql`${contacts.handles}::text ilike ${`%${q.replace(/^@/, '')}%`}`))
      .limit(6);
    return rows.map((r) => ({ type: 'Contact', title: r.name, sub: `${r.type}${r.organization ? ` · ${r.organization}` : ''}`, href: `/marketing/contacts/${r.id}`, icon: 'person' }));
  },
});
