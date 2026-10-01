import { z } from 'zod';
import { compact, defineTool } from '@labelconsole/core/tools';
import * as svc from '../service';

/**
 * Agents get stream data only through these tools: derived numbers from the
 * YouTube Data API, a licensed provider and distributor statements. No raw
 * provider payloads, and nothing from Spotify's Web API, ever reaches a prompt.
 */
export const tools = [
  defineTool({
    name: 'streams_get_history',
    module: 'streams',
    description:
      'Stream history for one track or one artist: per platform and source, the running total, plays in the window, the last 7 days versus the 7 before, and daily points. Sources are reported separately: "youtube-data-api" (official YouTube views), "licensed-provider" (licensed DSP counts) and "statement-import" (exact units per distributor statement period, months in arrears).',
    input: z.object({ trackId: z.uuid().optional(), artistId: z.uuid().optional(), days: z.number().int().min(7).max(365).default(90) }).refine((v) => v.trackId || v.artistId, 'Give a trackId or an artistId'),
    permission: 'streams:read',
    risk: 'read',
    idempotent: true,
    execute: (t, i) => t.withOrg(async (ctx) => compact({ ...(i.trackId ? { trackId: i.trackId } : { artistId: i.artistId }), series: await svc.historyForAgent(ctx, { trackId: i.trackId, artistId: i.artistId, days: i.days }) })),
  }),
  defineTool({
    name: 'streams_top_movers',
    module: 'streams',
    description: 'Tracks whose plays changed most versus the previous window (7 or 28 days), gainers and decliners, from polled sources (YouTube and the licensed provider).',
    input: z.object({ window: z.enum(['7d', '28d']).default('7d'), limit: z.number().int().min(1).max(25).default(10) }),
    permission: 'streams:read',
    risk: 'read',
    idempotent: true,
    execute: (t, i) => t.withOrg(async (ctx) => compact(await svc.movers(ctx, { window: i.window, limit: i.limit }))),
  }),
];
