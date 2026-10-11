import './types';
import { sql } from 'drizzle-orm';
import { defineModule } from '@labelconsole/core/modules';
import { routes } from './api';
import { jobs } from './jobs';
import { manifest } from './manifest';
import { discordCorrections, discordLinks, discordLookups } from './schema';

export default defineModule({
  manifest,
  routes,
  jobs,
  schedules: [{ id: 'discord-purge', job: 'discord.purge', cron: '17 4 * * *' }],
  attention: async (ctx) => {
    if (!ctx.can('catalogue:write')) return [];
    const [r] = await ctx.tx.select({ n: sql<number>`count(*)::int` }).from(discordCorrections).where(sql`${discordCorrections.status} = 'pending'`);
    return [{ n: r?.n ?? 0, tone: 'ink', title: 'Corrections suggested from Discord', sub: 'Waiting for review', href: '/settings/discord' }];
  },
  /** Launch metrics across labels (aggregates only): lookups by outcome, latency and cache use over the last day. */
  metrics: async (db) => {
    const [[links], outcomes, [timing]] = await Promise.all([
      db.select({ n: sql<number>`count(*)::int` }).from(discordLinks),
      db.select({ outcome: discordLookups.outcome, n: sql<number>`count(*)::int` }).from(discordLookups).where(sql`${discordLookups.createdAt} > now() - interval '24 hours'`).groupBy(discordLookups.outcome),
      db
        .select({ p50: sql<number | null>`percentile_cont(0.5) within group (order by ${discordLookups.durationMs})`, p95: sql<number | null>`percentile_cont(0.95) within group (order by ${discordLookups.durationMs})`, cached: sql<number>`count(*) filter (where ${discordLookups.cached})::int`, total: sql<number>`count(*)::int` })
        .from(discordLookups)
        .where(sql`${discordLookups.createdAt} > now() - interval '24 hours'`),
    ]);
    return [
      { name: 'lc_discord_links', help: 'Discord accounts linked to members', type: 'gauge', samples: [{ value: links?.n ?? 0 }] },
      { name: 'lc_discord_lookups_24h', help: 'Discord commands in the last 24 hours, by outcome', type: 'gauge', samples: outcomes.map((o) => ({ labels: { outcome: o.outcome }, value: o.n })) },
      { name: 'lc_discord_lookup_ms_24h', help: 'Discord command time in the last 24 hours (ms)', type: 'gauge', samples: [{ labels: { quantile: '0.5' }, value: Number(timing?.p50 ?? 0) }, { labels: { quantile: '0.95' }, value: Number(timing?.p95 ?? 0) }] },
      { name: 'lc_discord_cache_hits_24h', help: 'Discord commands answered from the lookup cache in the last 24 hours', type: 'gauge', samples: [{ value: timing?.cached ?? 0 }] },
    ];
  },
});
