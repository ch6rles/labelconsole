import '../types';
import { and, desc, eq, inArray } from 'drizzle-orm';
import { defineJob, type JobContext } from '@labelconsole/core/queue';
import { publish } from '@labelconsole/core/realtime';
import { organizations } from '@labelconsole/core/db/schema';
import { pickIsrcMatch, spotScraperFor, type SpotifyRelease, type SpotScraperClient } from '@labelconsole/core/spotscraper';
import { recordUsage } from '@labelconsole/core/usage';
import { readSecret } from '@labelconsole/core/vault';
import { readFileHead } from '@labelconsole/drive/service';
import { normalizeIsrc, normalizeUpc, parseInput, type ParsedInput } from '../metadata/input';
import { resolveMetadata, type ResolveCredentials } from '../metadata/resolve';
import type { AppleSecret } from '../metadata/sources/apple';
import type { LicensedSecret } from '../metadata/sources/licensed';
import type { SpotifySecret } from '../metadata/sources/spotify';
import { readTags, type AudioTags } from '../metadata/tags';
import { imports, metadataLookups, platformIdentities, tracks } from '../schema';
import { findArtistByName, getArtist, updateArtist } from '@labelconsole/people/service';
import { addImportedCredits, artistsOnTrack, confirmLookup, createLookup, distributorReference, tracksWithoutCredits, upsertIdentity } from '../service';

async function credentials(job: JobContext): Promise<ResolveCredentials> {
  return job.withOrg(async (ctx) => {
    const [spotify, apple, youtube, licensed, spotscraper] = await Promise.all([readSecret(ctx, 'spotify'), readSecret(ctx, 'apple_music'), readSecret(ctx, 'youtube'), readSecret(ctx, 'licensed_streams'), spotScraperFor(ctx)]);
    return {
      spotscraper,
      spotify: (spotify?.secret as SpotifySecret | undefined) ?? null,
      apple: (apple?.secret as AppleSecret | undefined) ?? null,
      youtubeApiKey: youtube?.secret.apiKey ?? null,
      licensed: (licensed?.secret as LicensedSecret | undefined) ?? null,
    };
  });
}

/** Bill SpotScraper requests to the label's usage counters. */
async function countRequests(job: JobContext, client: SpotScraperClient | null | undefined) {
  if (!client?.requests) return;
  const n = client.requests;
  client.requests = 0;
  await job.withOrg((ctx) => recordUsage(ctx, 'spotscraper_requests', n));
}

/** Resolve one lookup; HTTP calls happen outside any database transaction. */
async function resolveLookup(job: JobContext, lookupId: string, creds?: ResolveCredentials) {
  const lookup = await job.withOrg(async (ctx) => {
    const [row] = await ctx.tx.update(metadataLookups).set({ status: 'running', error: null }).where(eq(metadataLookups.id, lookupId)).returning();
    return row;
  });
  if (!lookup) return null;
  try {
    let parsed: ParsedInput | null;
    let tags: AudioTags | null = null;
    if (lookup.input.fileId) {
      const { head } = await job.withOrg((ctx) => readFileHead(ctx, lookup.input.fileId));
      tags = readTags(head);
      parsed = { kind: 'file', fileId: lookup.input.fileId };
    } else parsed = parseInput(lookup.input.input ?? '');
    if (!parsed) throw new Error('Unrecognised input');
    const [ref, c] = await Promise.all([job.withOrg((ctx) => distributorReference(ctx)), creds ? Promise.resolve(creds) : credentials(job)]);
    const result = await resolveMetadata(parsed, lookup.input, { creds: c, ...ref, tags }).finally(() => countRequests(job, c.spotscraper));
    await job.withOrg((ctx) => ctx.tx.update(metadataLookups).set({ status: 'done', result }).where(eq(metadataLookups.id, lookupId)));
    await publish(job.orgId!, { type: 'catalogue.lookup.updated', data: { lookupId, status: 'done' }, permission: 'catalogue:read' });
    return result;
  } catch (err) {
    await job.withOrg((ctx) => ctx.tx.update(metadataLookups).set({ status: 'failed', error: (err as Error).message.slice(0, 500) }).where(eq(metadataLookups.id, lookupId)));
    await publish(job.orgId!, { type: 'catalogue.lookup.updated', data: { lookupId, status: 'failed' }, permission: 'catalogue:read' });
    throw err;
  }
}

/**
 * The Spotify ID for each track: a confirmed identity (the one Streams polls
 * first), else an ISRC search, whose match is stored as a confirmed identity.
 */
async function spotifyIdsFor(job: JobContext, client: SpotScraperClient, trackIds: string[]) {
  const known = await job.withOrg(async (ctx) => {
    const rows = await ctx.tx
      .select({ trackId: platformIdentities.entityId, externalId: platformIdentities.externalId, variant: platformIdentities.variant })
      .from(platformIdentities)
      .where(and(eq(platformIdentities.entityType, 'track'), inArray(platformIdentities.entityId, trackIds), eq(platformIdentities.platform, 'spotify'), eq(platformIdentities.status, 'confirmed')))
      .orderBy(desc(platformIdentities.confidence));
    const byTrack = new Map<string, string>();
    for (const r of [...rows].sort((a, b) => Number(b.variant === 'primary') - Number(a.variant === 'primary'))) if (!byTrack.has(r.trackId)) byTrack.set(r.trackId, r.externalId);
    const rest = trackIds.filter((t) => !byTrack.has(t));
    const info = rest.length ? await ctx.tx.select({ id: tracks.id, isrc: tracks.isrc }).from(tracks).where(inArray(tracks.id, rest)) : [];
    const names = await artistsOnTrack(ctx, rest);
    return { byTrack, search: info.filter((t) => t.isrc).map((t) => ({ trackId: t.id, isrc: t.isrc!, artists: (names.get(t.id) ?? []).map((n) => n.name) })) };
  });
  const found: Array<{ trackId: string; spotifyId: string }> = [];
  for (const s of known.search) {
    const pick = pickIsrcMatch(await client.searchIsrc(s.isrc), s.isrc, s.artists);
    if (pick) found.push({ trackId: s.trackId, spotifyId: pick.id });
  }
  if (found.length) {
    await job.withOrg(async (ctx) => {
      for (const f of found) await upsertIdentity(ctx, { entityType: 'track', entityId: f.trackId, platform: 'spotify', externalId: f.spotifyId, url: `https://open.spotify.com/track/${f.spotifyId}`, source: 'spotscraper', confidence: 1, status: 'confirmed' });
    });
  }
  for (const f of found) known.byTrack.set(f.trackId, f.spotifyId);
  return known.byTrack;
}

const norm = (s: string | null | undefined) =>
  (s ?? '')
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();

/** Whether a release names the label in its label field or ℗/© lines. */
export function releasedByLabel(r: { labelName: string | null; pLine: string | null; cLine: string | null }, labelName: string) {
  const want = norm(labelName);
  return Boolean(want) && [r.labelName, r.pLine, r.cLine].some((v) => norm(v).includes(want));
}

/**
 * Work through an import's queued items: resolve each, then create records
 * when sources agree (bulk CSV with auto-confirm) or stop for review. A
 * Spotify sync trusts Spotify's details over small disagreements (a label
 * spelling, a release date a day apart) and stops only when the codes clash.
 */
async function processImport(job: JobContext, importId: string) {
  const row = await job.withOrg(async (ctx) => (await ctx.tx.select().from(imports).where(eq(imports.id, importId)))[0]);
  if (!row) return;
  await job.withOrg((ctx) => ctx.tx.update(imports).set({ status: 'running' }).where(eq(imports.id, row.id)));
  const creds = await credentials(job);
  const spotify = row.kind === 'spotify';
  const labelName = spotify && row.meta.onlyLabel ? await job.withOrg(async (ctx) => (await ctx.tx.select({ name: organizations.name }).from(organizations).where(eq(organizations.id, ctx.orgId)))[0]?.name ?? null) : null;
  const items = [...row.items];
  let succeeded = row.succeeded;
  let failed = row.failed;
  let skipped = row.meta.skipped ?? 0;
  for (let i = 0; i < items.length; i++) {
    if (items[i].status !== 'queued') continue;
    try {
      const lookup = await job.withOrg((ctx) => createLookup(ctx, { input: items[i].value }, { importId: row.id, enqueue: false }));
      const result = await resolveLookup(job, lookup.id, creds);
      const found = Boolean(result && (result.isrc || result.upc));
      const clean = found && (spotify ? !result!.conflicts.some((c) => c.field === 'upc' || c.field === 'isrc') : result!.conflicts.length === 0);
      if (found && labelName && !releasedByLabel(result!, labelName)) {
        // Not the label's release (e.g. before signing): leave it out, and its lookup with it.
        await job.withOrg((ctx) => ctx.tx.delete(metadataLookups).where(eq(metadataLookups.id, lookup.id)));
        items[i] = { value: items[i].value, status: 'skipped', error: `Released by ${result!.labelName ?? 'another label'}` };
        skipped++;
      } else if (row.autoConfirm && clean) {
        const done = await job.withOrg((ctx) => confirmLookup(ctx, lookup.id));
        items[i] = { value: items[i].value, status: 'imported', releaseId: done.releaseId };
        succeeded++;
      } else if (found) {
        items[i] = { value: items[i].value, status: 'review' };
        succeeded++;
      } else {
        items[i] = { value: items[i].value, status: 'not_found' };
        failed++;
      }
    } catch (err) {
      items[i] = { value: items[i].value, status: 'error', error: (err as Error).message.slice(0, 200) };
      failed++;
    }
    await job.withOrg((ctx) => ctx.tx.update(imports).set({ items, processed: i + 1, succeeded, failed, meta: { ...row.meta, skipped } }).where(eq(imports.id, row.id)));
    await job.progress(Math.round(((i + 1) / items.length) * 100));
    if ((i + 1) % 5 === 0 || i === items.length - 1) await publish(job.orgId!, { type: 'catalogue.import.progress', data: { importId: row.id, processed: i + 1, total: items.length }, permission: 'catalogue:read' });
  }
  await job.withOrg((ctx) => ctx.tx.update(imports).set({ status: 'done' }).where(eq(imports.id, row.id)));
}

export const jobs = [
  /** Credits from Spotify for the given tracks, or for every track without credits. */
  defineJob('catalogue.import-credits', async (job, data) => {
    const client = await job.withOrg((ctx) => spotScraperFor(ctx));
    if (!client) return { skipped: 'no SpotScraper key' };
    const trackIds = data.trackIds?.length ? data.trackIds : (await job.withOrg((ctx) => tracksWithoutCredits(ctx))).map((t) => t.id);
    let added = 0;
    let matched = 0;
    try {
      const ids = await spotifyIdsFor(job, client, trackIds);
      for (const [trackId, spotifyId] of ids) {
        const res = await client.credits(spotifyId);
        if (!res?.credits.length) continue;
        matched++;
        added += (await job.withOrg((ctx) => addImportedCredits(ctx, trackId, res.credits))).added;
      }
    } finally {
      await countRequests(job, client);
    }
    job.log.info({ tracks: trackIds.length, matched, added }, 'spotify credits imported');
    return { tracks: trackIds.length, matched, added };
  }),

  defineJob('catalogue.resolve', async (job, data) => {
    await resolveLookup(job, data.lookupId);
  }),

  defineJob('catalogue.bulk-import', async (job, data) => {
    await processImport(job, data.importId);
  }),

  /** An artist's Spotify releases: read the discography, then import each new release. */
  defineJob('catalogue.spotify-sync', async (job, data) => {
    const row = await job.withOrg(async (ctx) => (await ctx.tx.select().from(imports).where(eq(imports.id, data.importId)))[0]);
    if (!row || row.status !== 'queued' || !row.meta.artistId || !row.meta.spotifyArtistId) return;
    const fail = (error: string) => job.withOrg((ctx) => ctx.tx.update(imports).set({ status: 'failed', meta: { ...row.meta, error } }).where(eq(imports.id, row.id)));
    const client = await job.withOrg((ctx) => spotScraperFor(ctx));
    if (!client) return fail('No SpotScraper key is configured');
    let releases: SpotifyRelease[] | null;
    let spotifyName: string | null = null;
    try {
      [releases, spotifyName] = await Promise.all([client.discography(row.meta.spotifyArtistId), client.artist(row.meta.spotifyArtistId).then((a) => a?.name ?? null)]);
    } catch (err) {
      await countRequests(job, client);
      await fail((err as Error).message.slice(0, 200));
      throw err;
    }
    await countRequests(job, client);
    if (!releases) return fail('Spotify has no artist with that ID');
    const known = await job.withOrg(async (ctx) => {
      // Credits under the artist's Spotify name should land on this roster artist, so imports don't create a duplicate.
      if (spotifyName) {
        const holder = await findArtistByName(ctx, spotifyName);
        if (!holder) {
          const artist = await getArtist(ctx, row.meta.artistId!);
          await updateArtist(ctx, artist.id, { aliases: [...artist.aliases, spotifyName] });
        }
      }
      const ids = releases!.map((r) => r.id);
      if (ids.length === 0) return new Set<string>();
      const rows = await ctx.tx
        .select({ externalId: platformIdentities.externalId })
        .from(platformIdentities)
        .where(and(eq(platformIdentities.entityType, 'release'), eq(platformIdentities.platform, 'spotify'), inArray(platformIdentities.externalId, ids)));
      return new Set(rows.map((r) => r.externalId));
    });
    const fresh = releases.filter((r) => !known.has(r.id));
    await job.withOrg((ctx) =>
      ctx.tx
        .update(imports)
        .set({ total: fresh.length, items: fresh.map((r) => ({ value: `https://open.spotify.com/album/${r.id}`, status: 'queued' })), meta: { ...row.meta, alreadyInCatalogue: known.size, found: releases!.length } })
        .where(eq(imports.id, row.id)),
    );
    await processImport(job, row.id);
  }),
];

export { normalizeIsrc, normalizeUpc };
