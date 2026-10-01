import './types';
import { ilike } from 'drizzle-orm';
import { defineModule } from '@labelconsole/core/modules';
import * as fmt from '@labelconsole/ui/format';
import { tools } from './agent-tools';
import { routes } from './api';
import { jobs } from './jobs';
import { manifest } from './manifest';
import { campaigns } from './schema';
import * as svc from './service';

export default defineModule({
  manifest,
  routes,
  jobs,
  tools,
  widgets: [
    {
      id: 'campaigns',
      name: 'Campaigns',
      icon: 'campaign',
      desc: 'Active creator campaigns and unlinked spend',
      permission: 'marketing:read',
      load: async (ctx) => {
        const o = await svc.marketingOverview(ctx);
        const proof = o.tasks.find((t) => t.key === 'proof');
        return { value: String(o.activeCampaigns), unit: 'active', line: proof ? `${fmt.moneyCents(proof.moneyCents)} paid without proof` : 'Every paid booking has proof linked', cta: 'Open marketing', href: '/marketing' };
      },
    },
  ],
  stats: async (ctx) => {
    if (!ctx.can('marketing:read')) return [];
    const o = await svc.marketingOverview(ctx);
    return [
      { label: 'CASH SPEND', icon: 'account_balance_wallet', value: fmt.moneyCents(o.cashOutCents), note: o.lastPaidAt ? `all time · last payment ${fmt.shortDate(o.lastPaidAt)}` : 'all time · no payments yet', group: 'health' },
      { label: 'ACTIVE CAMPAIGNS', icon: 'campaign', value: String(o.activeCampaigns), group: 'marketing' },
      { label: 'TOTAL VIEWS', icon: 'visibility', value: fmt.compact(o.views), note: `${o.measured} of ${o.bookings} bookings measured`, group: 'marketing' },
    ];
  },
  attention: async (ctx) => {
    if (!ctx.can('marketing:read')) return [];
    const o = await svc.marketingOverview(ctx);
    const proof = o.tasks.find((t) => t.key === 'proof');
    return [{ n: proof?.n ?? 0, tone: 'ink', title: 'Paid bookings without proof', sub: proof ? `${fmt.moneyCents(proof.moneyCents)} paid with no post linked` : '', href: '/marketing' }];
  },
  search: async (ctx, q) => {
    if (!ctx.can('marketing:read')) return [];
    const rows = await ctx.tx.select({ id: campaigns.id, name: campaigns.name, status: campaigns.status }).from(campaigns).where(ilike(campaigns.name, `%${q}%`)).limit(6);
    return rows.map((r) => ({ type: 'Campaign', title: r.name, sub: `Campaign · ${r.status}`, href: `/marketing/campaigns/${r.id}`, icon: 'campaign' }));
  },
  enrich: {
    // Streams polls tracks of live campaigns every 6 hours.
    'stream-tier': async (ctx, trackIds) => {
      const active = await svc.activeCampaignTrackIds(ctx, trackIds);
      return Object.fromEntries([...active].map((id) => [id, { active: true }]));
    },
  },
});
