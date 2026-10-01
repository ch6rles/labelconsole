import { and, eq, gt, ilike, isNull, or, sql } from 'drizzle-orm';
import { defineModule } from '@labelconsole/core/modules';
import { routes } from './api';
import { jobs } from './jobs';
import { manifest } from './manifest';
import { invitations, memberships, organizations, users } from '@labelconsole/core/db/schema';

export default defineModule({
  manifest,
  routes,
  onboarding: async (ctx) => {
    const [org] = await ctx.tx.select({ settings: organizations.settings }).from(organizations).where(eq(organizations.id, ctx.orgId));
    const [[members], [invites]] = await Promise.all([
      ctx.tx.select({ n: sql<number>`count(*)::int` }).from(memberships).where(and(eq(memberships.orgId, ctx.orgId), eq(memberships.status, 'active'))),
      ctx.tx.select({ n: sql<number>`count(*)::int` }).from(invitations).where(and(eq(invitations.orgId, ctx.orgId), isNull(invitations.acceptedAt), isNull(invitations.revokedAt), gt(invitations.expiresAt, new Date()))),
    ]);
    const s = org?.settings ?? {};
    return [
      { id: 'label', title: 'Fill in your label details', sub: 'Legal entity, distributor, timezone and currency: used on statements, schedules and agent briefs', done: Boolean(s.distributor && s.legalEntity), href: '/settings', order: 10 },
      { id: 'team', title: 'Invite your team', sub: 'Each person gets a role: marketing, A&R, finance and more', done: (members?.n ?? 0) > 1 || (invites?.n ?? 0) > 0, href: '/admin/users', order: 20 },
    ];
  },
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
