import { desc, eq, sql } from 'drizzle-orm';
import Papa from 'papaparse';
import { z } from 'zod';
import type { ServiceContext } from '@labelconsole/core/context';
import { NotFoundError, ValidationError } from '@labelconsole/core/errors';
import { enqueueAfterCommit } from '@labelconsole/core/queue';
import { ensureArtist } from '@labelconsole/people/service';
import { hintsToLearn } from '../metadata/distributor';
import { normalizeIsrc, normalizeUpc, parseInput } from '../metadata/input';
import { distributorAliases, distributorHints, imports, metadataLookups, RELEASE_TYPES, tracks, type ResolvedMetadata } from '../schema';
import { createRelease, findReleaseByUpc, linkTrack, updateRelease } from './releases';
import { createTrack, findTrackByIsrc, recomputeBlockers } from './tracks';
import { upsertIdentity } from './identities';

export const LookupInput = z.object({ input: z.string().trim().min(1).max(500).optional(), fileId: z.uuid().optional() }).refine((v) => v.input || v.fileId, 'Paste a link, ISRC, UPC or title');

export async function createLookup(ctx: ServiceContext, body: z.infer<typeof LookupInput>, opts: { importId?: string; enqueue?: boolean } = {}) {
  ctx.assert('catalogue:write');
  const input: Record<string, string> = body.fileId ? { fileId: body.fileId } : { input: body.input! };
  if (body.input && !parseInput(body.input)) throw new ValidationError('That link is not from a supported service (Spotify, Apple Music, Deezer, YouTube)', { fieldErrors: { input: ['Unsupported link'] } });
  const [row] = await ctx.tx.insert(metadataLookups).values({ input, importId: opts.importId ?? null }).returning();
  if (opts.enqueue !== false) enqueueAfterCommit(ctx, 'catalogue.resolve', { lookupId: row.id }, { jobId: `resolve-${row.id}`, attempts: 3 });
  return row;
}

export async function getLookup(ctx: ServiceContext, id: string) {
  ctx.assert('catalogue:read');
  const [row] = await ctx.tx.select().from(metadataLookups).where(eq(metadataLookups.id, id));
  if (!row) throw new NotFoundError('Lookup');
  return row;
}

export async function recentLookups(ctx: ServiceContext) {
  ctx.assert('catalogue:read');
  return ctx.tx.select().from(metadataLookups).orderBy(desc(metadataLookups.createdAt)).limit(15);
}

export async function distributorReference(ctx: ServiceContext) {
  const [aliases, hints] = await Promise.all([ctx.tx.select().from(distributorAliases), ctx.tx.select().from(distributorHints)]);
  return {
    aliases: aliases.map((a) => ({ distributor: a.distributor, pattern: a.pattern, weight: Number(a.weight) })),
    hints: hints.map((h) => ({ kind: h.kind as 'upc_prefix' | 'label_string', value: h.value, distributor: h.distributor, confirmations: h.confirmations })),
  };
}

export const ConfirmInput = z.object({
  title: z.string().trim().min(1).max(300).optional(),
  type: z.enum(RELEASE_TYPES).optional(),
  releaseDate: z.iso.date().nullable().optional(),
  labelName: z.string().trim().max(200).nullable().optional(),
  distributor: z.string().trim().max(120).nullable().optional(),
  artistNames: z.array(z.string().trim().min(1)).max(10).optional(),
  status: z.enum(['collecting', 'draft', 'scheduled', 'live']).optional(),
});

/**
 * Turn a reviewed lookup into catalogue records: the release (or the existing
 * one with the same UPC), its tracks (deduplicated by ISRC), artists, and
 * platform identities. Exact identifier matches are confirmed; matches found
 * by searching a title wait for human review. Emits catalogue.track.imported,
 * which the stream tracker picks up.
 */
export async function confirmLookup(ctx: ServiceContext, lookupId: string, overrides: z.infer<typeof ConfirmInput> = {}) {
  ctx.assert('catalogue:write');
  const lookup = await getLookup(ctx, lookupId);
  if (lookup.status === 'confirmed' && lookup.releaseId) return { releaseId: lookup.releaseId, created: false };
  const r = lookup.result as ResolvedMetadata | null;
  if (lookup.status !== 'done' || !r) throw new ValidationError('This lookup has not finished resolving');
  if (!r.isrc && !r.upc && r.tracks.length === 0) throw new ValidationError('Nothing was found to import');
  const bySearch = r.input.matchedBy === 'search';

  const artistNames = overrides.artistNames?.length ? overrides.artistNames : r.artists.length ? r.artists : ['Unknown artist'];
  const artistIds: string[] = [];
  for (const name of artistNames) artistIds.push((await ensureArtist(ctx, name)).id);

  const distributor = overrides.distributor !== undefined ? overrides.distributor : r.distributor.name;
  const existing = r.upc ? await findReleaseByUpc(ctx, r.upc) : null;
  const releaseFields = {
    title: overrides.title ?? r.releaseTitle ?? r.title ?? 'Untitled release',
    type: overrides.type ?? (RELEASE_TYPES.includes(r.releaseType as never) ? (r.releaseType as (typeof RELEASE_TYPES)[number]) : r.tracks.length > 6 ? 'album' : r.tracks.length > 1 ? 'ep' : 'single'),
    releaseDate: overrides.releaseDate !== undefined ? overrides.releaseDate : r.releaseDate && /^\d{4}-\d{2}-\d{2}$/.test(r.releaseDate) ? r.releaseDate : null,
    labelName: overrides.labelName !== undefined ? overrides.labelName : r.labelName,
    distributor,
    pLine: r.pLine,
    cLine: r.cLine,
    status: overrides.status ?? (r.releaseDate && r.releaseDate <= new Date().toISOString().slice(0, 10) ? 'live' : 'scheduled'),
  } as const;

  const release = existing
    ? await updateRelease(ctx, existing.id, { labelName: existing.labelName ?? releaseFields.labelName, distributor: existing.distributor ?? distributor, pLine: existing.pLine ?? r.pLine, cLine: existing.cLine ?? r.cLine })
    : await createRelease(ctx, { ...releaseFields, upc: r.upc, artistIds, distributorConfidence: overrides.distributor !== undefined ? 1 : r.distributor.confidence, distributorEvidence: r.distributor.evidence });

  // Tracks: the full tracklist when we have one, otherwise the single track.
  const trackSpecs = r.tracks.length ? r.tracks : [{ title: r.title ?? releaseFields.title, isrc: r.isrc, durationMs: r.durationMs, position: 1, explicit: r.explicit, artists: r.artists }];
  const imported: Array<{ trackId: string; isrc: string | null }> = [];
  for (const spec of trackSpecs) {
    const isrc = spec.isrc ? normalizeIsrc(spec.isrc) : null;
    let track = isrc ? await findTrackByIsrc(ctx, isrc) : null;
    if (!track) {
      const trackArtistIds: string[] = [];
      for (const name of spec.artists.length ? spec.artists : artistNames) trackArtistIds.push((await ensureArtist(ctx, name)).id);
      const created = await createTrack(ctx, { title: spec.title, isrc, durationMs: spec.durationMs, explicit: spec.explicit ?? false, artistIds: trackArtistIds });
      track = (await ctx.tx.select().from(tracks).where(eq(tracks.id, created.id)))[0];
    }
    await linkTrack(ctx, release.id, track.id, spec.position);
    imported.push({ trackId: track.id, isrc: track.isrc });
  }

  // Platform identities: release-level and the track matching the looked-up ISRC.
  const primaryTrack = imported.find((t) => t.isrc && t.isrc === r.isrc) ?? (imported.length === 1 ? imported[0] : null);
  for (const p of r.platformIds) {
    const entityId = p.entity === 'release' ? release.id : primaryTrack?.trackId;
    if (!entityId) continue;
    const exact = !bySearch || p.source === 'link';
    await upsertIdentity(ctx, { entityType: p.entity, entityId, platform: p.platform, externalId: p.externalId, url: p.url, source: p.source, confidence: exact ? 1 : 0.6, status: exact ? 'confirmed' : 'pending_review', variant: p.platform === 'youtube' ? 'official' : null });
  }

  // Learn: a confirmed distributor teaches the label-string and UPC-prefix tables.
  if (distributor) {
    for (const h of hintsToLearn({ upc: r.upc, labelName: releaseFields.labelName }, distributor)) {
      await ctx.tx
        .insert(distributorHints)
        .values(h)
        .onConflictDoUpdate({ target: [distributorHints.orgId, distributorHints.kind, distributorHints.value, distributorHints.distributor], set: { confirmations: sql`${distributorHints.confirmations} + 1` } });
    }
  }

  await ctx.tx.update(metadataLookups).set({ status: 'confirmed', releaseId: release.id }).where(eq(metadataLookups.id, lookupId));
  for (const t of imported) {
    await recomputeBlockers(ctx, t.trackId);
    await ctx.emit('catalogue.track.imported', { trackId: t.trackId, isrc: t.isrc, releaseId: release.id, platformIds: r.platformIds.filter((p) => p.entity === 'track').map((p) => ({ platform: p.platform, externalId: p.externalId })) });
  }
  await ctx.audit({ action: 'release.imported', module: 'catalogue', targetType: 'release', targetId: release.id, targetLabel: release.title, after: { tracks: imported.length, upc: r.upc, distributor } });
  return { releaseId: release.id, created: !existing, tracks: imported.length };
}

/* ---------------------------------------------------------- bulk CSV -- */

export const BulkInput = z.object({ csv: z.string().min(1).max(2_000_000), autoConfirm: z.boolean().default(false) });

/** Accept a CSV of ISRCs or UPCs (any column named isrc/upc/barcode/ean, or the first column). */
export function parseCodesCsv(csv: string): string[] {
  const parsed = Papa.parse<Record<string, string>>(csv.trim(), { header: true, skipEmptyLines: true, transformHeader: (h) => h.trim().toLowerCase() });
  const fields = parsed.meta.fields ?? [];
  const col = fields.find((f) => ['isrc', 'upc', 'barcode', 'ean', 'code'].includes(f));
  let values: string[];
  if (col) values = parsed.data.map((r) => r[col] ?? '');
  else {
    // No header row: treat every line's first cell as a code.
    values = Papa.parse<string[]>(csv.trim(), { skipEmptyLines: true }).data.map((r) => r[0] ?? '');
  }
  const codes = values.map((v) => v.trim()).filter((v) => normalizeIsrc(v) || normalizeUpc(v));
  return [...new Set(codes)];
}

export async function createBulkImport(ctx: ServiceContext, input: z.infer<typeof BulkInput>) {
  ctx.assert('catalogue:write');
  const codes = parseCodesCsv(input.csv);
  if (codes.length === 0) throw new ValidationError('No valid ISRCs or UPCs found in the file');
  if (codes.length > 5000) throw new ValidationError('Import up to 5,000 codes at a time');
  const [row] = await ctx.tx
    .insert(imports)
    .values({ kind: 'codes', total: codes.length, autoConfirm: input.autoConfirm, items: codes.map((value) => ({ value, status: 'queued' })) })
    .returning();
  await ctx.audit({ action: 'import.started', module: 'catalogue', targetType: 'import', targetId: row.id, after: { codes: codes.length, autoConfirm: input.autoConfirm } });
  enqueueAfterCommit(ctx, 'catalogue.bulk-import', { importId: row.id }, { jobId: `bulk-${row.id}`, attempts: 1 });
  return row;
}

export async function getImport(ctx: ServiceContext, id: string) {
  ctx.assert('catalogue:read');
  const [row] = await ctx.tx.select().from(imports).where(eq(imports.id, id));
  if (!row) throw new NotFoundError('Import');
  return row;
}

export async function recentImports(ctx: ServiceContext) {
  ctx.assert('catalogue:read');
  return ctx.tx.select().from(imports).orderBy(desc(imports.createdAt)).limit(10);
}
