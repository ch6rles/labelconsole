import { eq, ilike, or } from 'drizzle-orm';
import { memberships, users } from '@labelconsole/core/db/schema';
import { defineModule } from '@labelconsole/core/modules';
import { routes } from './api';
import { jobs } from './jobs';
import { manifest } from './manifest';

export default defineModule({
  manifest,
  routes,
  jobs,
  search: async (ctx, q) => {
    if (!ctx.can('settings:read')) return [];
    const rows = await ctx.tx
      .select({ name: users.name, email: users.email })
      .from(users)
      .innerJoin(memberships, eq(memberships.userId, users.id))
      .where(or(ilike(users.name, `%${q}%`), ilike(users.email, `%${q}%`)))
      .limit(5);
    return rows.map((r) => ({ type: 'Member', title: r.name, sub: r.email, href: '/admin/users', icon: 'person' }));
  },
});
