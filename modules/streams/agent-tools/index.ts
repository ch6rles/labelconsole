import { z } from 'zod';
import { spotifyIdFrom, spotScraperFor } from '@labelconsole/core/spotscraper';
import { compact, defineTool } from '@labelconsole/core/tools';
import { recordUsage } from '@labelconsole/core/usage';
import * as svc from '../service';
import { tools as spotifyTools } from './spotify';

/**
 * Agents get stream data only through these tools: derived numbers from the
 * YouTube Data API, Spotify play counts and audience figures (SpotScraper), a
 * licensed provider and distributor statements. No raw provider payload ever
 * reaches a prompt.
 */
export const tools = [
  defineTool({
    name: 'streams_get_history',
    module: 'streams',
    description:
      'Stream history for one track or one artist: per platform and source, the running total, plays in the window, the last 7 days versus the 7 before, and daily points. The first day of tracking (trackedSince) has no plays figure (null): growth is counted from the second reading. Sources are reported separately: "spotscraper" (Spotify play counts), "youtube-data-api" or "youtube-scraper" (public YouTube views, through the API or Apify; the art track is the YouTube Music upload), "licensed-provider" (licensed DSP counts) and "statement-import" (exact units per distributor statement period, months in arrears).',
    input: z.object({ trackId: z.uuid().optional(), artistId: z.uuid().optional(), days: z.number().int().min(7).max(365).default(90) }).refine((v) => v.trackId || v.artistId, 'Give a trackId or an artistId'),
    permission: 'streams:read',
    risk: 'read',
    idempotent: true,
    execute: (t, i) => t.withOrg(async (ctx) => compact({ ...(i.trackId ? { trackId: i.trackId } : { artistId: i.artistId }), series: await svc.historyForAgent(ctx, { trackId: i.trackId, artistId: i.artistId, days: i.days }) })),
  }),
  defineTool({
    name: 'streams_top_movers',
    module: 'streams',
    description: 'Tracks whose plays changed most versus the previous window (7 or 28 days), gainers and decliners, from polled sources (Spotify, YouTube and the licensed provider). newlyTracked means there were no readings before this window, so the change is not a real gain.',
    input: z.object({ window: z.enum(['7d', '28d']).default('7d'), limit: z.number().int().min(1).max(25).default(10) }),
    permission: 'streams:read',
    risk: 'read',
    idempotent: true,
    execute: (t, i) => t.withOrg(async (ctx) => compact(await svc.movers(ctx, { window: i.window, limit: i.limit }))),
  }),
  defineTool({
    name: 'streams_artist_audience',
    module: 'streams',
    description:
      "A roster artist's Spotify audience from the daily reading: monthly listeners and followers with their change over 28 days, world rank, top cities, and the playlists listeners discovered them on (useful for finding similar playlists to pitch). Give an artistId, or a trackId for the track's primary artists. audience is null when the artist has no Spotify artist ID on their profile or no reading yet.",
    input: z.object({ artistId: z.uuid().optional(), trackId: z.uuid().optional() }).refine((v) => v.artistId || v.trackId, 'Give an artistId or a trackId'),
    permission: 'streams:read',
    risk: 'read',
    idempotent: true,
    execute: (t, i) =>
      t.withOrg(async (ctx) => {
        const ids = i.artistId ? [i.artistId] : await svc.primaryArtistIds(ctx, i.trackId!);
        return compact({ artists: await Promise.all(ids.map(async (artistId) => ({ artistId, audience: await svc.audienceForAgent(ctx, artistId) }))) });
      }),
  }),
  defineTool({
    name: 'streams_spotify_artist_lookup',
    module: 'streams',
    description:
      'Look up any artist on Spotify by profile link (for example a demo submitter or a potential collaborator): monthly listeners, followers, world rank and top cities. One paid lookup per call, so use it only for artists you are actually assessing.',
    input: z.object({ spotifyUrl: z.string().trim().min(10).max(300).describe('open.spotify.com/artist/… link or spotify:artist: URI') }),
    permission: 'streams:read',
    risk: 'read',
    idempotent: true,
    rateLimit: { capacity: 10, refillPerSec: 0.2 },
    execute: async (t, i) => {
      const id = spotifyIdFrom(i.spotifyUrl, 'artist');
      if (!id) return { error: 'Not a Spotify artist link' };
      const client = await t.withOrg((ctx) => spotScraperFor(ctx));
      if (!client) return { error: 'No SpotScraper key is configured for this label' };
      const a = await client.artist(id, t.signal);
      await t.withOrg((ctx) => recordUsage(ctx, 'spotscraper_requests', client.requests));
      if (!a) return { error: 'No Spotify artist with that ID' };
      return { name: a.name, verified: a.verified, monthlyListeners: a.monthlyListeners, followers: a.followers, worldRank: a.worldRank, topCities: a.topCities.slice(0, 5) };
    },
  }),
  ...spotifyTools,
];
