import type { ServiceContext } from '@labelconsole/core/context';
import { spotScraperFor, type SpotScraperClient } from '@labelconsole/core/spotscraper';
import { recordUsage } from '@labelconsole/core/usage';
import { readSecret } from '@labelconsole/core/vault';
import type { ResolveContext, ResolveCredentials } from '../metadata/resolve';
import type { AppleSecret } from '../metadata/sources/apple';
import type { LicensedSecret } from '../metadata/sources/licensed';
import type { SpotifySecret } from '../metadata/sources/spotify';
import { distributorReference } from './imports';

/**
 * Lookups for other modules (e.g. Discord) that show metadata without
 * creating a lookup record. Reading the keys decrypts secrets, so these run in
 * the worker; the provider calls themselves belong outside any transaction.
 */
export async function metadataCredentials(ctx: ServiceContext): Promise<ResolveCredentials> {
  const [spotify, apple, youtube, licensed, spotscraper] = await Promise.all([readSecret(ctx, 'spotify'), readSecret(ctx, 'apple_music'), readSecret(ctx, 'youtube'), readSecret(ctx, 'licensed_streams'), spotScraperFor(ctx)]);
  return {
    spotscraper,
    spotify: (spotify?.secret as SpotifySecret | undefined) ?? null,
    apple: (apple?.secret as AppleSecret | undefined) ?? null,
    youtubeApiKey: youtube?.secret.apiKey ?? null,
    licensed: (licensed?.secret as LicensedSecret | undefined) ?? null,
  };
}

/** Everything `resolveMetadata` needs from the label: provider keys and distributor reference data. */
export async function resolveContext(ctx: ServiceContext): Promise<ResolveContext> {
  const [ref, creds] = await Promise.all([distributorReference(ctx), metadataCredentials(ctx)]);
  return { creds, ...ref };
}

/** Bill the SpotScraper requests a lookup made to the label's usage counters. */
export async function recordSpotScraperRequests(ctx: ServiceContext, client: SpotScraperClient | null | undefined) {
  if (!client?.requests) return;
  const n = client.requests;
  client.requests = 0;
  await recordUsage(ctx, 'spotscraper_requests', n);
}

export { normalizeIsrc, normalizeUpc, parseInput, type ParsedInput } from '../metadata/input';
export { resolveMetadata, type ResolveContext } from '../metadata/resolve';
export { searchCandidates, unambiguousCandidate, normText, type SearchCandidate } from '../metadata/search';
