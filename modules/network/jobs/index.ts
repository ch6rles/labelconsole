import '../types';
import { sql } from 'drizzle-orm';
import { systemDb } from '@labelconsole/core/db/client';
import { env } from '@labelconsole/core/env';
import { defineJob, enqueue } from '@labelconsole/core/queue';
import { spotScraperFor } from '@labelconsole/core/spotscraper';
import { recordUsage } from '@labelconsole/core/usage';
import { applySpotifyPlaylist, spotifyPlaylists } from '../service';

export const jobs = [
  /**
   * Weekly, on a new Spotify playlist, or on demand: follower counts for
   * Spotify playlists, one SpotScraper request each.
   */
  defineJob('network.refresh-playlists', async (job, data) => {
    if (!job.orgId) {
      const week = Math.floor(Date.now() / (7 * 86400_000));
      const rows = (await systemDb().execute(sql`
        select distinct p.org_id from playlists p
        where p.platform = 'spotify' and (p.external_id is not null or p.url ilike '%spotify.com/playlist/%')
          and (${Boolean(env().SPOTSCRAPER_API_KEY)} or exists (select 1 from credentials c where c.org_id = p.org_id and c.provider = 'spotscraper' and c.revoked_at is null))
        limit 1000`)) as unknown as Array<{ org_id: string }>;
      for (const r of rows) await enqueue('network.refresh-playlists', r.org_id, {}, { jobId: `playlists-${r.org_id}-w${week}`, attempts: 3 });
      return { labels: rows.length };
    }
    const client = await job.withOrg((ctx) => spotScraperFor(ctx));
    if (!client) return { skipped: 'no SpotScraper key' };
    const list = await job.withOrg((ctx) => spotifyPlaylists(ctx, data.playlistIds));
    let updated = 0;
    try {
      for (const p of list) {
        const details = await client.playlist(p.spotifyId);
        if (!details) continue;
        if (await job.withOrg((ctx) => applySpotifyPlaylist(ctx, p.id, details))) updated++;
      }
    } finally {
      if (client.requests) await job.withOrg((ctx) => recordUsage(ctx, 'spotscraper_requests', client.requests));
    }
    return { playlists: list.length, updated };
  }),
];
