import './types';
import { ilike, or } from 'drizzle-orm';
import { defineModule } from '@labelconsole/core/modules';
import { tools } from './agent-tools';
import { routes } from './api';
import { manifest } from './manifest';
import { artists } from './schema';
import { onboardingBoard } from './service';

export default defineModule({
  manifest,
  routes,
  tools,
  attention: async (ctx) => {
    if (!ctx.can('people:read')) return [];
    const board = await onboardingBoard(ctx);
    const open = board.filter((b) => b.done < b.total);
    const noPayout = open.filter((b) => !b.artist.onboarding.payout).length;
    return [{ n: open.length, tone: 'ink', title: 'Artist onboarding', sub: open.length ? `${noPayout} missing payout details` : '', href: '/people/onboarding' }];
  },
  search: async (ctx, q) => {
    if (!ctx.can('people:read')) return [];
    const rows = await ctx.tx.select({ id: artists.id, name: artists.name, status: artists.status }).from(artists).where(or(ilike(artists.name, `%${q}%`), ilike(artists.legalName, `%${q}%`))).limit(6);
    return rows.map((r) => ({ type: 'Artist', title: r.name, sub: `Artist · ${r.status}`, href: `/people/artists/${r.id}`, icon: 'person' }));
  },
});
