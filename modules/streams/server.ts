import './types';
import '@labelconsole/catalogue/types';
import '@labelconsole/documents/types';
import { defineListener, defineModule } from '@labelconsole/core/modules';
import { enqueueAfterCommit } from '@labelconsole/core/queue';
import { fmt } from '@labelconsole/ui';
import { tools } from './agent-tools';
import { routes } from './api';
import { jobs } from './jobs';
import { manifest } from './manifest';
import * as svc from './service';

export default defineModule({
  manifest,
  routes,
  jobs,
  tools,
  schedules: [
    { id: 'streams-schedule', job: 'streams.schedule', everyMs: 15 * 60_000 },
    { id: 'streams-partitions', job: 'streams.maintain-partitions', cron: '17 3 * * *' },
  ],
  listeners: [
    // Track registry: every track that enters the catalogue is tracked.
    defineListener({ id: 'streams.register-created-track', event: 'catalogue.track.created', handle: async (ctx, e) => void (await svc.registerTrack(ctx, e.payload.trackId)) }),
    defineListener({ id: 'streams.register-imported-track', event: 'catalogue.track.imported', handle: async (ctx, e) => void (await svc.registerTrack(ctx, e.payload.trackId)) }),
    // Statement-import adapter: exact counts from parsed distributor statements.
    defineListener({
      id: 'streams.statement-parsed',
      event: 'documents.statement.parsed',
      handle: async (ctx, e) => enqueueAfterCommit(ctx, 'streams.import-statement', { documentId: e.payload.documentId }, { jobId: `stmt-streams-${e.payload.documentId}-${e.id}`, attempts: 3 }),
    }),
  ],
  stats: async (ctx) => {
    if (!ctx.can('streams:read')) return [];
    const o = await svc.overview(ctx);
    return [
      {
        label: 'STREAMS · 28D',
        icon: 'visibility',
        value: o.throughDay ? fmt.compact(o.plays28d) : '—',
        delta: o.changePct != null ? fmt.pct(o.changePct, { signed: true, decimals: 1 }) : undefined,
        note: o.throughDay ? `through ${o.throughDay}` : o.tracking.tracking ? 'first readings pending' : 'no tracks tracked yet',
        group: 'health',
      },
    ];
  },
  attention: async (ctx) => {
    if (!ctx.can('streams:read')) return [];
    const o = await svc.overview(ctx);
    const items = [{ n: o.openAlerts, tone: 'ink' as const, title: 'Stream alerts to look at', sub: 'Spikes, drops and milestones from the tracker', href: '/streams/alerts' }];
    if (ctx.can('streams:manage')) items.push({ n: o.pendingMatches + o.tracking.pendingMatch, tone: 'ink' as const, title: 'Tracks waiting for a YouTube match', sub: `${o.pendingMatches} suggested matches to review`, href: '/streams/matching' });
    return items;
  },
  enrich: {
    artist: async (ctx, ids) => {
      const rows = await svc.plays28dByArtist(ctx, ids);
      return Object.fromEntries(rows.map((r) => [r.artistId, { streams28d: r.plays }]));
    },
  },
});
