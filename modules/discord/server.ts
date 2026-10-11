import './types';
import { sql } from 'drizzle-orm';
import { defineModule } from '@labelconsole/core/modules';
import { routes } from './api';
import { jobs } from './jobs';
import { manifest } from './manifest';
import { pausedSources } from '@labelconsole/catalogue/service';
import { discordCorrections, discordLinks, discordLookups } from './schema';

export default defineModule({
  manifest,
  routes,
  jobs,
  schedules: [
    { id: 'discord-purge', job: 'discord.purge', cron: '17 4 * * *' },
    { id: 'discord-readings', job: 'discord.readings-all', cron: '41 6 * * *' },
  ],
  attention: async (ctx) => {
    if (!ctx.can('catalogue:write')) return [];
    const [r] = await ctx.tx.select({ n: sql<number>`count(*)::int` }).from(discordCorrections).where(sql`${discordCorrections.status} = 'pending'`);
    return [{ n: r?.n ?? 0, tone: 'ink', title: 'Corrections suggested from Discord', sub: 'Waiting for review', href: '/settings/discord' }];
  },
  /** Launch metrics across labels (aggregates only): lookups by outcome, latency and cache use over the last day. */
  metrics: async (db) => {
    const [[links], outcomes, [timing], calls, paused] = await Promise.all([
      db.select({ n: sql<number>`count(*)::int` }).from(discordLinks),
      db.select({ outcome: discordLookups.outcome, n: sql<number>`count(*)::int` }).from(discordLookups).where(sql`${discordLookups.createdAt} > now() - interval '24 hours'`).groupBy(discordLookups.outcome),
      db
        .select({ p50: sql<number | null>`percentile_cont(0.5) within group (order by ${discordLookups.durationMs})`, p95: sql<number | null>`percentile_cont(0.95) within group (order by ${discordLookups.durationMs})`, cached: sql<number>`count(*) filter (where ${discordLookups.cached})::int`, total: sql<number>`count(*)::int` })
        .from(discordLookups)
        .where(sql`${discordLookups.createdAt} > now() - interval '24 hours'`),
      db.execute(
        sql`select e->>'source' as source, e->>'outcome' as outcome, count(*)::int as n, coalesce(percentile_cont(0.95) within group (order by (e->>'ms')::int), 0) as p95
            from discord_lookups, jsonb_array_elements(discord_lookups.sources) as e
            where discord_lookups.created_at > now() - interval '24 hours' and discord_lookups.sources is not null
            group by 1, 2`,
      ) as unknown as Promise<Array<{ source: string; outcome: string; n: number; p95: number }>>,
      pausedSources(),
    ]);
    const answered = calls.filter((c) => c.outcome === 'answered');
    return [
      { name: 'lc_discord_links', help: 'Discord accounts linked to members', type: 'gauge', samples: [{ value: links?.n ?? 0 }] },
      { name: 'lc_discord_lookups_24h', help: 'Discord commands in the last 24 hours, by outcome', type: 'gauge', samples: outcomes.map((o) => ({ labels: { outcome: o.outcome }, value: o.n })) },
      { name: 'lc_discord_lookup_ms_24h', help: 'Discord command time in the last 24 hours (ms)', type: 'gauge', samples: [{ labels: { quantile: '0.5' }, value: Number(timing?.p50 ?? 0) }, { labels: { quantile: '0.95' }, value: Number(timing?.p95 ?? 0) }] },
      { name: 'lc_discord_cache_hits_24h', help: 'Discord commands answered from the lookup cache in the last 24 hours', type: 'gauge', samples: [{ value: timing?.cached ?? 0 }] },
      { name: 'lc_metadata_source_calls_24h', help: 'Metadata source calls from Discord lookups in the last 24 hours, by source and outcome', type: 'gauge', samples: calls.map((c) => ({ labels: { source: c.source, outcome: c.outcome }, value: c.n })) },
      { name: 'lc_metadata_source_ms_24h', help: '95th-percentile time of answered metadata source calls in the last 24 hours (ms)', type: 'gauge', samples: answered.map((c) => ({ labels: { source: c.source, quantile: '0.95' }, value: Math.round(Number(c.p95)) })) },
      {
        name: 'lc_metadata_source_paused',
        help: 'Metadata sources paused by the circuit breaker right now (label-keyed sources count once per label)',
        type: 'gauge',
        samples: [...new Set(paused.map((p) => p.source))].map((source) => ({ labels: { source }, value: paused.filter((p) => p.source === source).length })),
      },
    ];
  },
});
