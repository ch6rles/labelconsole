import '../types';
import { eq } from 'drizzle-orm';
import { defineJob, type JobContext } from '@labelconsole/core/queue';
import { publish } from '@labelconsole/core/realtime';
import { readSecret } from '@labelconsole/core/vault';
import { readFileHead } from '@labelconsole/drive/service';
import { normalizeIsrc, normalizeUpc, parseInput, type ParsedInput } from '../metadata/input';
import { resolveMetadata, type ResolveCredentials } from '../metadata/resolve';
import type { AppleSecret } from '../metadata/sources/apple';
import type { LicensedSecret } from '../metadata/sources/licensed';
import type { SpotifySecret } from '../metadata/sources/spotify';
import { readTags, type AudioTags } from '../metadata/tags';
import { imports, metadataLookups } from '../schema';
import { confirmLookup, createLookup, distributorReference } from '../service';

async function credentials(job: JobContext): Promise<ResolveCredentials> {
  return job.withOrg(async (ctx) => {
    const [spotify, apple, youtube, licensed] = await Promise.all([readSecret(ctx, 'spotify'), readSecret(ctx, 'apple_music'), readSecret(ctx, 'youtube'), readSecret(ctx, 'licensed_streams')]);
    return {
      spotify: (spotify?.secret as SpotifySecret | undefined) ?? null,
      apple: (apple?.secret as AppleSecret | undefined) ?? null,
      youtubeApiKey: youtube?.secret.apiKey ?? null,
      licensed: (licensed?.secret as LicensedSecret | undefined) ?? null,
    };
  });
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
    const result = await resolveMetadata(parsed, lookup.input, { creds: c, ...ref, tags });
    await job.withOrg((ctx) => ctx.tx.update(metadataLookups).set({ status: 'done', result }).where(eq(metadataLookups.id, lookupId)));
    await publish(job.orgId!, { type: 'catalogue.lookup.updated', data: { lookupId, status: 'done' }, permission: 'catalogue:read' });
    return result;
  } catch (err) {
    await job.withOrg((ctx) => ctx.tx.update(metadataLookups).set({ status: 'failed', error: (err as Error).message.slice(0, 500) }).where(eq(metadataLookups.id, lookupId)));
    await publish(job.orgId!, { type: 'catalogue.lookup.updated', data: { lookupId, status: 'failed' }, permission: 'catalogue:read' });
    throw err;
  }
}

export const jobs = [
  defineJob('catalogue.resolve', async (job, data) => {
    await resolveLookup(job, data.lookupId);
  }),

  defineJob('catalogue.bulk-import', async (job, data) => {
    const row = await job.withOrg(async (ctx) => (await ctx.tx.select().from(imports).where(eq(imports.id, data.importId)))[0]);
    if (!row) return;
    await job.withOrg((ctx) => ctx.tx.update(imports).set({ status: 'running' }).where(eq(imports.id, row.id)));
    const creds = await credentials(job);
    const items = [...row.items];
    let succeeded = row.succeeded;
    let failed = row.failed;
    for (let i = 0; i < items.length; i++) {
      if (items[i].status !== 'queued') continue;
      try {
        const lookup = await job.withOrg((ctx) => createLookup(ctx, { input: items[i].value }, { importId: row.id, enqueue: false }));
        const result = await resolveLookup(job, lookup.id, creds);
        const clean = result && (result.isrc || result.upc) && result.conflicts.length === 0;
        if (row.autoConfirm && clean) {
          const done = await job.withOrg((ctx) => confirmLookup(ctx, lookup.id));
          items[i] = { value: items[i].value, status: 'imported', releaseId: done.releaseId };
          succeeded++;
        } else if (result && (result.isrc || result.upc)) {
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
      await job.withOrg((ctx) => ctx.tx.update(imports).set({ items, processed: i + 1, succeeded, failed }).where(eq(imports.id, row.id)));
      await job.progress(Math.round(((i + 1) / items.length) * 100));
      if ((i + 1) % 5 === 0 || i === items.length - 1) await publish(job.orgId!, { type: 'catalogue.import.progress', data: { importId: row.id, processed: i + 1, total: items.length }, permission: 'catalogue:read' });
    }
    await job.withOrg((ctx) => ctx.tx.update(imports).set({ status: 'done' }).where(eq(imports.id, row.id)));
  }),
];

export { normalizeIsrc, normalizeUpc };
