import './types';
import type { JobContext } from '@labelconsole/core/queue';
import { recordSpotScraperRequests, resolveContext, spotifyPlayCount } from '@labelconsole/catalogue/service';
import { recordReading, songsToFollow } from './service';

/** Stop for the day after this many failures in a row: SpotScraper is down or the key is wrong. */
const MAX_FAILURES = 3;

/**
 * One label's daily readings: the Spotify play count of songs looked up in
 * Discord recently, so their chart has a point a day. One billed SpotScraper
 * request per song; off unless an admin sets a number in Settings → Discord.
 */
export async function runDailyReadings(job: JobContext, limit: number) {
  if (limit <= 0) return { skipped: 'off' };
  const rctx = await job.withOrg((ctx) => resolveContext(ctx));
  const client = rctx.creds.spotscraper;
  if (!client) return { skipped: 'SpotScraper is not connected' };
  const isrcs = await job.withOrg((ctx) => songsToFollow(ctx, limit));
  let read = 0;
  let failures = 0;
  try {
    for (const isrc of isrcs) {
      const count = await spotifyPlayCount(client, { isrc }).catch((err) => {
        failures++;
        job.log.warn({ err, isrc }, 'daily reading failed');
        return undefined;
      });
      if (failures >= MAX_FAILURES) break;
      if (count === undefined) continue;
      failures = 0;
      if (count == null) continue;
      await job.withOrg((ctx) => recordReading(ctx, { isrc, platform: 'spotify', source: 'spotscraper', count }));
      read++;
    }
  } finally {
    await job.withOrg((ctx) => recordSpotScraperRequests(ctx, client)).catch(() => undefined);
  }
  return { read, songs: isrcs.length };
}
