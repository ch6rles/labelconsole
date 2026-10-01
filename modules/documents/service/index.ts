import '../types';
import { and, asc, desc, eq, gte, ilike, inArray, isNotNull, isNull, lte, ne, or, sql } from 'drizzle-orm';
import { z } from 'zod';
import type { ServiceContext } from '@labelconsole/core/context';
import { ForbiddenError, NotFoundError, ValidationError } from '@labelconsole/core/errors';
import { enqueueAfterCommit } from '@labelconsole/core/queue';
import { releaseArtists, releases, releaseTracks, trackArtists, tracks } from '@labelconsole/catalogue/schema';
import { artists } from '@labelconsole/people/schema';
import { downloadUrl, ensureSystemFolder, getFilesByIds, storeFile } from '@labelconsole/drive/service';
import { CONTRACT_STATUSES, DOCUMENT_TYPES, documentAccessLog, documentLinks, documents, keyDates, statementLines, type ContractTerms, type Document, type StatementSummary } from '../schema';

/* ------------------------------------------------------------ access --- */

function readCondition(ctx: ServiceContext) {
  const conds = [];
  if (!ctx.can('documents:read_confidential')) conds.push(eq(documents.confidential, false));
  if (!ctx.can('documents:read_financial')) conds.push(ne(documents.type, 'statement'));
  return conds.length ? and(...conds) : undefined;
}

function assertCanRead(ctx: ServiceContext, d: Document) {
  ctx.assert('documents:read');
  if (d.confidential && !ctx.can('documents:read_confidential')) throw new ForbiddenError('This document is confidential');
  if (d.type === 'statement' && !ctx.can('documents:read_financial')) throw new ForbiddenError('Statements need the financial documents permission');
}

/* ------------------------------------------------------------ upload --- */

export const LinkInput = z.object({ entityType: z.enum(['artist', 'release', 'track', 'campaign', 'contact']), entityId: z.uuid() });

export const UploadMeta = z.object({
  type: z.enum(DOCUMENT_TYPES).default('other'),
  title: z.string().trim().max(300).optional(),
  tags: z.array(z.string().trim().min(1).max(40)).max(20).default([]),
  confidential: z.boolean().default(false),
  contractStatus: z.enum(CONTRACT_STATUSES).nullable().optional(),
  links: z.array(LinkInput).max(20).default([]),
});

/** Store a document's file in Drive and record it; extraction runs in the worker. */
export async function uploadDocument(ctx: ServiceContext, file: { name: string; mime: string; body: ReadableStream<Uint8Array> | Buffer }, meta: z.input<typeof UploadMeta>, previous?: Document) {
  ctx.assert('documents:write');
  const m = UploadMeta.parse(meta);
  if (m.type === 'statement') ctx.assert('documents:read_financial');
  if (m.confidential && !ctx.can('documents:read_confidential')) throw new ForbiddenError('You cannot create confidential documents');
  const folder = await ensureSystemFolder(ctx, m.type === 'contract' ? 'Contracts' : m.type === 'statement' ? 'Statements' : 'Documents');
  const stored = await storeFile(ctx, { name: file.name, mime: file.mime, body: file.body, folderId: folder.id, confidential: m.confidential, kind: 'document' });
  const [row] = await ctx.tx
    .insert(documents)
    .values({
      type: m.type,
      title: m.title || previous?.title || file.name.replace(/\.[a-z0-9]+$/i, ''),
      fileId: stored.id,
      mime: stored.mime,
      size: stored.size,
      tags: m.tags.length ? m.tags : previous?.tags ?? [],
      confidential: m.confidential || Boolean(previous?.confidential),
      contractStatus: m.type === 'contract' ? m.contractStatus ?? previous?.contractStatus ?? 'draft' : null,
      version: previous ? previous.version + 1 : 1,
      previousId: previous?.id ?? null,
      parties: previous?.parties ?? [],
      extractionStatus: m.type === 'other' ? 'none' : 'queued',
    })
    .returning();
  const links = previous ? await ctx.tx.select().from(documentLinks).where(eq(documentLinks.documentId, previous.id)) : [];
  for (const l of [...links.map((x) => ({ entityType: x.entityType as z.infer<typeof LinkInput>['entityType'], entityId: x.entityId })), ...m.links]) {
    await ctx.tx.insert(documentLinks).values({ documentId: row.id, entityType: l.entityType, entityId: l.entityId }).onConflictDoNothing();
  }
  if (previous) await ctx.tx.update(documents).set({ isLatest: false }).where(eq(documents.id, previous.id));
  await ctx.audit({ action: previous ? 'document.version_uploaded' : 'document.uploaded', module: 'documents', targetType: 'document', targetId: row.id, targetLabel: row.title, after: { type: row.type, version: row.version, confidential: row.confidential } });
  await ctx.emit('documents.document.uploaded', { documentId: row.id, title: row.title, type: row.type });
  if (row.type === 'contract') enqueueAfterCommit(ctx, 'documents.extract', { documentId: row.id }, { jobId: `extract-${row.id}`, attempts: 3 });
  if (row.type === 'statement') enqueueAfterCommit(ctx, 'documents.parse-statement', { documentId: row.id }, { jobId: `statement-${row.id}`, attempts: 3 });
  return row;
}

export async function uploadVersion(ctx: ServiceContext, id: string, file: { name: string; mime: string; body: ReadableStream<Uint8Array> | Buffer }) {
  const prev = await getDocumentRow(ctx, id);
  if (!prev.isLatest) throw new ValidationError('Upload new versions against the latest version');
  return uploadDocument(ctx, file, { type: prev.type, confidential: prev.confidential }, prev);
}

/* -------------------------------------------------------------- read --- */

export const ListQuery = z.object({
  type: z.enum(DOCUMENT_TYPES).optional(),
  q: z.string().trim().max(100).optional(),
  tag: z.string().max(40).optional(),
  entityType: z.string().optional(),
  entityId: z.uuid().optional(),
  includeOld: z.enum(['1', '0']).optional(),
});

export async function listDocuments(ctx: ServiceContext, q: Partial<z.infer<typeof ListQuery>> = {}) {
  ctx.assert('documents:read');
  const conds = [readCondition(ctx)];
  if (q.includeOld !== '1') conds.push(eq(documents.isLatest, true));
  if (q.type) conds.push(eq(documents.type, q.type));
  if (q.tag) conds.push(sql`${q.tag} = any(${documents.tags})`);
  if (q.q) conds.push(or(ilike(documents.title, `%${q.q}%`), ilike(documents.textContent, `%${q.q}%`)));
  if (q.entityType && q.entityId) conds.push(inArray(documents.id, ctx.tx.select({ id: documentLinks.documentId }).from(documentLinks).where(and(eq(documentLinks.entityType, q.entityType), eq(documentLinks.entityId, q.entityId)))));
  const rows = await ctx.tx
    .select({ id: documents.id, type: documents.type, title: documents.title, mime: documents.mime, size: documents.size, version: documents.version, tags: documents.tags, confidential: documents.confidential, contractStatus: documents.contractStatus, extractionStatus: documents.extractionStatus, termsConfirmedAt: documents.termsConfirmedAt, expiryDate: documents.expiryDate, signedAt: documents.signedAt, createdAt: documents.createdAt, parties: documents.parties, terms: documents.terms, extractedTerms: documents.extractedTerms })
    .from(documents)
    .where(and(...conds.filter(Boolean)))
    .orderBy(desc(documents.createdAt))
    .limit(500);
  const links = rows.length ? await ctx.tx.select().from(documentLinks).where(inArray(documentLinks.documentId, rows.map((r) => r.id))) : [];
  return rows.map((r) => ({ ...r, links: links.filter((l) => l.documentId === r.id).map((l) => ({ entityType: l.entityType, entityId: l.entityId })) }));
}

export async function getDocumentRow(ctx: ServiceContext, id: string) {
  const [d] = await ctx.tx.select().from(documents).where(eq(documents.id, id));
  if (!d) throw new NotFoundError('Document');
  assertCanRead(ctx, d);
  return d;
}

export async function getDocument(ctx: ServiceContext, id: string) {
  const d = await getDocumentRow(ctx, id);
  const [links, dates, versions] = await Promise.all([
    ctx.tx.select().from(documentLinks).where(eq(documentLinks.documentId, id)),
    ctx.tx.select().from(keyDates).where(eq(keyDates.documentId, id)).orderBy(asc(keyDates.date)),
    versionChain(ctx, d),
  ]);
  const artistIds = links.filter((l) => l.entityType === 'artist').map((l) => l.entityId);
  const releaseIds = links.filter((l) => l.entityType === 'release').map((l) => l.entityId);
  const [artistRows, releaseRows] = await Promise.all([
    artistIds.length ? ctx.tx.select({ id: artists.id, name: artists.name }).from(artists).where(inArray(artists.id, artistIds)) : [],
    releaseIds.length ? ctx.tx.select({ id: releases.id, title: releases.title }).from(releases).where(inArray(releases.id, releaseIds)) : [],
  ]);
  if (d.confidential && ctx.actor.type !== 'system') await ctx.tx.insert(documentAccessLog).values({ documentId: id, actor: ctx.actor.type === 'user' ? `user:${ctx.actor.id}` : `agent:${ctx.actor.id}`, action: 'view', ip: ctx.ip });
  return { document: d, links, artists: artistRows, releases: releaseRows, keyDates: dates, versions };
}

async function versionChain(ctx: ServiceContext, d: Document) {
  const chain: Array<Pick<Document, 'id' | 'version' | 'createdAt' | 'isLatest'>> = [];
  // Walk back through previous versions.
  let cur: Document | undefined = d;
  while (cur?.previousId && chain.length < 50) {
    [cur] = await ctx.tx.select().from(documents).where(eq(documents.id, cur.previousId));
    if (cur) chain.push({ id: cur.id, version: cur.version, createdAt: cur.createdAt, isLatest: cur.isLatest });
  }
  // And forward to newer ones.
  const newer: typeof chain = [];
  let next: Document | undefined = d;
  while (next && newer.length < 50) {
    [next] = await ctx.tx.select().from(documents).where(eq(documents.previousId, next.id));
    if (next) newer.push({ id: next.id, version: next.version, createdAt: next.createdAt, isLatest: next.isLatest });
  }
  return [...newer.reverse(), { id: d.id, version: d.version, createdAt: d.createdAt, isLatest: d.isLatest }, ...chain];
}

/** Signed short-lived link; confidential documents are logged. */
export async function documentDownloadUrl(ctx: ServiceContext, id: string, inline = false) {
  const d = await getDocumentRow(ctx, id);
  if (!d.fileId) throw new NotFoundError('File');
  await ctx.tx.insert(documentAccessLog).values({ documentId: id, actor: ctx.actor.type === 'system' ? 'system' : `${ctx.actor.type}:${ctx.actor.id}`, action: inline ? 'preview' : 'download', ip: ctx.ip });
  return downloadUrl(ctx, d.fileId, { inline });
}

export async function accessLog(ctx: ServiceContext, id: string) {
  await getDocumentRow(ctx, id);
  return ctx.tx.select().from(documentAccessLog).where(eq(documentAccessLog.documentId, id)).orderBy(desc(documentAccessLog.createdAt)).limit(100);
}

/* ------------------------------------------------------------- write --- */

export const DocumentPatch = z.object({
  title: z.string().trim().min(1).max(300),
  tags: z.array(z.string().trim().min(1).max(40)).max(20),
  confidential: z.boolean(),
  contractStatus: z.enum(CONTRACT_STATUSES).nullable(),
  signedAt: z.iso.date().nullable(),
  effectiveDate: z.iso.date().nullable(),
  expiryDate: z.iso.date().nullable(),
}).partial();

export async function updateDocument(ctx: ServiceContext, id: string, patch: z.infer<typeof DocumentPatch>) {
  ctx.assert('documents:write');
  const before = await getDocumentRow(ctx, id);
  if (patch.confidential !== undefined && !ctx.can('documents:read_confidential')) throw new ForbiddenError('Only people who can open confidential documents can change the flag');
  const [after] = await ctx.tx.update(documents).set(patch).where(eq(documents.id, id)).returning();
  await ctx.audit({ action: patch.contractStatus && patch.contractStatus !== before.contractStatus ? 'contract.status_changed' : 'document.updated', module: 'documents', targetType: 'document', targetId: id, targetLabel: after.title, before: before as never, after: after as never });
  return after;
}

export async function linkDocument(ctx: ServiceContext, id: string, link: z.infer<typeof LinkInput>) {
  ctx.assert('documents:write');
  await getDocumentRow(ctx, id);
  await ctx.tx.insert(documentLinks).values({ documentId: id, ...link }).onConflictDoNothing();
}

export async function unlinkDocument(ctx: ServiceContext, id: string, link: z.infer<typeof LinkInput>) {
  ctx.assert('documents:write');
  await ctx.tx.delete(documentLinks).where(and(eq(documentLinks.documentId, id), eq(documentLinks.entityType, link.entityType), eq(documentLinks.entityId, link.entityId)));
}

export async function deleteDocument(ctx: ServiceContext, id: string) {
  ctx.assert('documents:delete');
  const d = await getDocumentRow(ctx, id);
  // Deleting the newest version makes the previous one current again.
  if (d.previousId && d.isLatest) await ctx.tx.update(documents).set({ isLatest: true }).where(eq(documents.id, d.previousId));
  await ctx.tx.delete(documents).where(eq(documents.id, id));
  await ctx.audit({ action: 'document.deleted', module: 'documents', targetType: 'document', targetId: id, targetLabel: d.title });
}

export async function requestExtraction(ctx: ServiceContext, id: string) {
  ctx.assert('documents:write');
  const d = await getDocumentRow(ctx, id);
  if (d.type === 'other') throw new ValidationError('Set the document type to contract or statement first');
  await ctx.tx.update(documents).set({ extractionStatus: 'queued', extractionError: null }).where(eq(documents.id, id));
  enqueueAfterCommit(ctx, d.type === 'contract' ? 'documents.extract' : 'documents.parse-statement', { documentId: id }, { jobId: `${d.type}-${id}-${Date.now()}`, attempts: 3 });
  return { queued: true };
}

/* ---------------------------------------------------- confirm terms --- */

const Iso = z.iso.date().nullable();
export const TermsInput = z.object({
  agreementType: z.string().max(200).nullable(),
  parties: z.array(z.object({ name: z.string().min(1).max(200), role: z.string().max(80), artistId: z.uuid().nullable().optional() })).max(20),
  effectiveDate: Iso,
  termDescription: z.string().max(300).nullable(),
  termEndDate: Iso,
  territory: z.string().max(200).nullable(),
  royaltyArtistPct: z.number().min(0).max(100).nullable(),
  royaltyLabelPct: z.number().min(0).max(100).nullable(),
  royaltyBasis: z.string().max(200).nullable(),
  advanceAmount: z.number().min(0).nullable(),
  advanceCurrency: z.string().max(3).nullable(),
  recoupment: z.string().max(1000).nullable(),
  options: z.array(z.object({ description: z.string().max(500), exerciseBy: Iso })).max(20),
  keyDates: z.array(z.object({ kind: z.enum(['expiry', 'option', 'renewal', 'notice', 'payment', 'other']), date: z.iso.date(), description: z.string().max(500) })).max(50),
  releasesCovered: z.array(z.string().max(300)).max(100),
  notes: z.string().max(2000).nullable(),
});

/**
 * Apply extracted terms after a person reviewed (and possibly edited) them.
 * Key dates are created here, never straight from extraction.
 */
export async function confirmTerms(ctx: ServiceContext, id: string, terms: z.infer<typeof TermsInput>) {
  ctx.assert('documents:write');
  const d = await getDocumentRow(ctx, id);
  if (d.type !== 'contract') throw new ValidationError('Only contracts have terms to confirm');
  const confirmer = ctx.actor.type === 'system' ? 'system' : `${ctx.actor.type}:${ctx.actor.id}`;
  const expiry = terms.termEndDate ?? terms.keyDates.find((k) => k.kind === 'expiry')?.date ?? null;
  const [after] = await ctx.tx
    .update(documents)
    .set({ terms: terms as ContractTerms, termsConfirmedAt: new Date(), termsConfirmedBy: confirmer, parties: terms.parties, effectiveDate: terms.effectiveDate, expiryDate: expiry })
    .where(eq(documents.id, id))
    .returning();
  await ctx.tx.delete(keyDates).where(eq(keyDates.documentId, id));
  const dates = [...terms.keyDates, ...terms.options.filter((o) => o.exerciseBy).map((o) => ({ kind: 'option' as const, date: o.exerciseBy!, description: o.description }))];
  if (expiry && !dates.some((k) => k.kind === 'expiry')) dates.push({ kind: 'expiry', date: expiry, description: 'Term ends' });
  const unique = new Map(dates.map((k) => [`${k.kind}:${k.date}`, k]));
  if (unique.size) await ctx.tx.insert(keyDates).values([...unique.values()].map((k) => ({ documentId: id, kind: k.kind, date: k.date, description: k.description })));
  for (const p of terms.parties) if (p.artistId) await ctx.tx.insert(documentLinks).values({ documentId: id, entityType: 'artist', entityId: p.artistId }).onConflictDoNothing();
  await ctx.audit({ action: 'contract.terms_confirmed', module: 'documents', targetType: 'document', targetId: id, targetLabel: d.title, before: (d.terms ?? null) as never, after: terms as never });
  await ctx.emit('documents.terms.confirmed', { documentId: id, title: d.title });
  return after;
}

/* --------------------------------------------------------- key dates --- */

export async function upcomingKeyDates(ctx: ServiceContext, withinDays = 120) {
  ctx.assert('documents:read');
  const to = new Date(Date.now() + withinDays * 86400_000).toISOString().slice(0, 10);
  const from = new Date(Date.now() - 30 * 86400_000).toISOString().slice(0, 10);
  return ctx.tx
    .select({ keyDate: keyDates, title: documents.title, documentId: documents.id, confidential: documents.confidential })
    .from(keyDates)
    .innerJoin(documents, eq(documents.id, keyDates.documentId))
    .where(and(gte(keyDates.date, from), lte(keyDates.date, to), isNull(keyDates.dismissedAt), readCondition(ctx)))
    .orderBy(asc(keyDates.date));
}

export async function dismissKeyDate(ctx: ServiceContext, id: string) {
  ctx.assert('documents:write');
  await ctx.tx.update(keyDates).set({ dismissedAt: new Date() }).where(eq(keyDates.id, id));
}

/* --------------------------------------------------------- contracts --- */

/** Contract status for an artist from their linked contracts (People's contract column). */
export function contractLabel(docs: Array<{ contractStatus: string | null; expiryDate: string | null }>) {
  const soon = new Date(Date.now() + 90 * 86400_000).toISOString().slice(0, 10);
  const today = new Date().toISOString().slice(0, 10);
  const signed = docs.filter((d) => d.contractStatus === 'signed' && (!d.expiryDate || d.expiryDate >= today));
  if (signed.length) {
    const expiring = signed.find((d) => d.expiryDate && d.expiryDate <= soon);
    if (expiring && signed.every((d) => d.expiryDate && d.expiryDate <= soon)) {
      const dt = new Date(expiring.expiryDate! + 'T00:00:00Z');
      return `Expiring ${dt.toLocaleString('en-US', { month: 'short', timeZone: 'UTC' })} ${dt.getUTCFullYear()}`;
    }
    return 'Signed';
  }
  if (docs.some((d) => d.contractStatus === 'sent')) return 'Sent';
  if (docs.some((d) => d.contractStatus === 'draft')) return 'Unsigned';
  if (docs.some((d) => d.contractStatus === 'expired' || (d.contractStatus === 'signed' && d.expiryDate && d.expiryDate < today))) return 'Expired';
  return 'None on file';
}

export async function contractsForArtists(ctx: ServiceContext, artistIds: string[]) {
  if (artistIds.length === 0) return [];
  return ctx.tx
    .select({ artistId: documentLinks.entityId, id: documents.id, title: documents.title, contractStatus: documents.contractStatus, expiryDate: documents.expiryDate, terms: documents.terms, signedAt: documents.signedAt, createdAt: documents.createdAt })
    .from(documentLinks)
    .innerJoin(documents, eq(documents.id, documentLinks.documentId))
    .where(and(eq(documentLinks.entityType, 'artist'), inArray(documentLinks.entityId, artistIds), eq(documents.type, 'contract'), eq(documents.isLatest, true), readCondition(ctx)));
}

/** Live releases whose primary artist has no signed, unexpired contract. */
export async function liveReleasesOnUnsignedPaper(ctx: ServiceContext) {
  const live = await ctx.tx
    .select({ releaseId: releases.id, title: releases.title, artistId: releaseArtists.artistId, artistName: artists.name })
    .from(releases)
    .innerJoin(releaseArtists, and(eq(releaseArtists.releaseId, releases.id), eq(releaseArtists.position, 0)))
    .innerJoin(artists, eq(artists.id, releaseArtists.artistId))
    .where(eq(releases.status, 'live'));
  const contracts = await contractsForArtists(ctx, [...new Set(live.map((l) => l.artistId))]);
  return live.filter((l) => contractLabel(contracts.filter((c) => c.artistId === l.artistId)) !== 'Signed' && !contractLabel(contracts.filter((c) => c.artistId === l.artistId)).startsWith('Expiring'));
}

/* -------------------------------------------------------- statements --- */

export async function listStatements(ctx: ServiceContext) {
  ctx.assert('documents:read_financial');
  return ctx.tx.select().from(documents).where(and(eq(documents.type, 'statement'), eq(documents.isLatest, true))).orderBy(desc(documents.createdAt)).limit(100);
}

export async function statementLinesFor(ctx: ServiceContext, documentId: string, limit = 500) {
  ctx.assert('documents:read_financial');
  return ctx.tx.select().from(statementLines).where(eq(statementLines.documentId, documentId)).orderBy(desc(statementLines.netCents)).limit(limit);
}

/** Booked revenue by month and source, and top releases, from imported statements. */
export async function royalties(ctx: ServiceContext, months = 12) {
  ctx.assert('documents:read_financial');
  const from = new Date(Date.UTC(new Date().getUTCFullYear(), new Date().getUTCMonth() - months + 1, 1)).toISOString().slice(0, 10);
  const latestDocs = ctx.tx.select({ id: documents.id }).from(documents).where(and(eq(documents.type, 'statement'), eq(documents.isLatest, true)));
  const base = and(inArray(statementLines.documentId, latestDocs), isNotNull(statementLines.periodStart), gte(statementLines.periodStart, from));
  const [byMonth, bySource, byRelease, latestPeriod] = await Promise.all([
    ctx.tx.select({ month: sql<string>`to_char(${statementLines.periodStart}, 'YYYY-MM')`, net: sql<number>`sum(${statementLines.netCents})::bigint`, units: sql<number>`sum(${statementLines.units})::bigint` }).from(statementLines).where(base).groupBy(sql`1`).orderBy(sql`1`),
    ctx.tx.select({ source: statementLines.source, net: sql<number>`sum(${statementLines.netCents})::bigint` }).from(statementLines).where(base).groupBy(statementLines.source).orderBy(sql`2 desc`),
    ctx.tx
      .select({ releaseId: sql<string | null>`coalesce(${statementLines.releaseId}, ${releaseTracks.releaseId})`, net: sql<number>`sum(${statementLines.netCents})::bigint`, gross: sql<number>`sum(${statementLines.grossCents})::bigint`, units: sql<number>`sum(${statementLines.units})::bigint` })
      .from(statementLines)
      .leftJoin(releaseTracks, eq(releaseTracks.trackId, statementLines.trackId))
      .where(base)
      .groupBy(sql`1`)
      .orderBy(sql`2 desc`)
      .limit(10),
    ctx.tx.select({ end: sql<string | null>`max(${statementLines.periodEnd})` }).from(statementLines).where(inArray(statementLines.documentId, latestDocs)),
  ]);
  const releaseIds = byRelease.map((r) => r.releaseId).filter((x): x is string => Boolean(x));
  const relRows = releaseIds.length
    ? await ctx.tx.select({ id: releases.id, title: releases.title, artistId: releaseArtists.artistId, artistName: artists.name }).from(releases).leftJoin(releaseArtists, and(eq(releaseArtists.releaseId, releases.id), eq(releaseArtists.position, 0))).leftJoin(artists, eq(artists.id, releaseArtists.artistId)).where(inArray(releases.id, releaseIds))
    : [];
  const contracts = await contractsForArtists(ctx, relRows.map((r) => r.artistId).filter((x): x is string => Boolean(x)));
  const top = byRelease.map((r) => {
    const rel = relRows.find((x) => x.id === r.releaseId);
    const terms = contracts.find((c) => c.artistId === rel?.artistId && c.terms?.royaltyArtistPct != null)?.terms ?? null;
    const net = Number(r.net);
    return {
      releaseId: r.releaseId,
      title: rel?.title ?? 'Unmatched lines',
      artist: rel?.artistName ?? '—',
      units: Number(r.units),
      grossCents: Number(r.gross),
      netCents: net,
      artistShareCents: terms?.royaltyArtistPct != null ? Math.round((net * terms.royaltyArtistPct) / 100) : null,
      labelShareCents: terms?.royaltyArtistPct != null ? Math.round((net * (100 - terms.royaltyArtistPct)) / 100) : null,
    };
  });
  return { byMonth: byMonth.map((m) => ({ month: m.month, netCents: Number(m.net), units: Number(m.units) })), bySource: bySource.map((s) => ({ source: s.source, netCents: Number(s.net) })), top, bookedThrough: latestPeriod[0]?.end ?? null };
}

/** Net revenue per artist over the last 12 months (People's "earned" column). */
export async function earningsByArtist(ctx: ServiceContext, artistIds: string[]) {
  if (artistIds.length === 0 || !ctx.can('documents:read_financial')) return [];
  const from = new Date(Date.now() - 365 * 86400_000).toISOString().slice(0, 10);
  return ctx.tx
    .select({ artistId: trackArtists.artistId, net: sql<number>`sum(${statementLines.netCents})::bigint` })
    .from(statementLines)
    .innerJoin(trackArtists, and(eq(trackArtists.trackId, statementLines.trackId), eq(trackArtists.role, 'primary')))
    .innerJoin(documents, and(eq(documents.id, statementLines.documentId), eq(documents.isLatest, true)))
    .where(and(inArray(trackArtists.artistId, artistIds), gte(statementLines.periodStart, from)))
    .groupBy(trackArtists.artistId);
}

export async function latestStatementSummary(ctx: ServiceContext) {
  const [d] = await ctx.tx.select().from(documents).where(and(eq(documents.type, 'statement'), eq(documents.isLatest, true), eq(documents.extractionStatus, 'done'))).orderBy(desc(documents.createdAt)).limit(1);
  return d ? { document: d, summary: d.extractedTerms as StatementSummary | null } : null;
}

export async function filesForDocuments(ctx: ServiceContext, docs: Document[]) {
  return getFilesByIds(ctx, docs.map((d) => d.fileId).filter((x): x is string => Boolean(x)));
}

export { tracks };
