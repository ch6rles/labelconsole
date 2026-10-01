import '../types';
import { and, desc, eq, inArray, isNull, lt, ne, sql } from 'drizzle-orm';
import { systemDb } from '@labelconsole/core/db/client';
import { organizations } from '@labelconsole/core/db/schema';
import { priceUsage } from '@labelconsole/core/llm-models';
import { enabledModuleIds } from '@labelconsole/core/modules';
import { defineJob, enqueue } from '@labelconsole/core/queue';
import { publish } from '@labelconsole/core/realtime';
import { extractText } from '@labelconsole/core/text';
import { llmProviderFor, recordUsage } from '@labelconsole/core/usage';
import { releases, tracks } from '@labelconsole/catalogue/schema';
import { readFileBuffer } from '@labelconsole/drive/service';
import { CONTRACT_SYSTEM, ContractTermsSchema, STATEMENT_LINES_HINT, STATEMENT_SYSTEM, StatementLinesSchema } from '../extract';
import { documents, keyDates, statementLines, type ContractTerms, type StatementSummary } from '../schema';
import { canonicalSource, parseStatementCsv, summarize, type ParsedLine } from '../statements';

const MAX_PDF_BYTES = 30 * 1024 * 1024;

export const jobs = [
  defineJob('documents.extract', async (job, data) => {
    const doc = await job.withOrg(async (ctx) => {
      const [d] = await ctx.tx.update(documents).set({ extractionStatus: 'running', extractionError: null }).where(eq(documents.id, data.documentId)).returning();
      return d;
    });
    if (!doc?.fileId) return;
    try {
      const { file, body } = await job.withOrg((ctx) => readFileBuffer(ctx, doc.fileId!, MAX_PDF_BYTES));
      const text = await extractText(body, file.mime).catch(() => null);
      const provider = await job.withOrg((ctx) => llmProviderFor(ctx));
      // PDFs go to Claude as documents (it reads layout and scans); other text goes inline.
      const content = file.mime === 'application/pdf'
        ? [{ type: 'document' as const, source: { type: 'base64' as const, media_type: 'application/pdf' as const, data: body.toString('base64') } }, { type: 'text' as const, text: 'Extract the terms of this agreement.' }]
        : [{ type: 'text' as const, text: `Extract the terms of this agreement:\n\n${(text?.text ?? body.toString('utf8')).slice(0, 400_000)}` }];
      const { data: terms, usage, model } = await provider.extract({ system: CONTRACT_SYSTEM, content, schema: ContractTermsSchema, maxTokens: 8000 });
      await job.withOrg(async (ctx) => {
        await ctx.tx
          .update(documents)
          .set({ extractionStatus: 'done', extractedTerms: { ...terms, parties: terms.parties.map((p) => ({ ...p, artistId: null })) } as ContractTerms, textContent: text?.text?.slice(0, 500_000) ?? null })
          .where(eq(documents.id, doc.id));
        await recordUsage(ctx, 'llm_cost_usd', priceUsage(model, usage));
        await ctx.emit('documents.terms.extracted', { documentId: doc.id, title: doc.title, keyDates: terms.keyDates.length });
      });
      await publish(job.orgId!, { type: 'documents.extraction.updated', data: { documentId: doc.id, status: 'done' }, permission: 'documents:read' });
    } catch (err) {
      await job.withOrg((ctx) => ctx.tx.update(documents).set({ extractionStatus: 'failed', extractionError: (err as Error).message.slice(0, 500) }).where(eq(documents.id, doc.id)));
      await publish(job.orgId!, { type: 'documents.extraction.updated', data: { documentId: doc.id, status: 'failed' }, permission: 'documents:read' });
      if ((err as { transient?: boolean }).transient) throw err;
    }
  }),

  defineJob('documents.parse-statement', async (job, data) => {
    const doc = await job.withOrg(async (ctx) => {
      const [d] = await ctx.tx.update(documents).set({ extractionStatus: 'running', extractionError: null }).where(eq(documents.id, data.documentId)).returning();
      return d;
    });
    if (!doc?.fileId) return;
    try {
      const { file, body } = await job.withOrg((ctx) => readFileBuffer(ctx, doc.fileId!, MAX_PDF_BYTES));
      const org = await job.withOrg(async (ctx) => (await ctx.tx.select().from(organizations).where(eq(organizations.id, ctx.orgId)))[0]);
      const currency = org.settings.currency ?? 'USD';
      let lines: ParsedLine[];
      let distributor: string | null = org.settings.distributor ?? null;
      if (file.mime === 'text/csv' || file.name.toLowerCase().endsWith('.csv') || file.mime === 'text/plain') {
        lines = parseStatementCsv(body.toString('utf8'), currency).lines;
      } else if (file.mime === 'application/pdf') {
        const provider = await job.withOrg((ctx) => llmProviderFor(ctx));
        const { data: out, usage, model } = await provider.extract({
          system: STATEMENT_SYSTEM,
          content: [{ type: 'document', source: { type: 'base64', media_type: 'application/pdf', data: body.toString('base64') } }, { type: 'text', text: STATEMENT_LINES_HINT }],
          schema: StatementLinesSchema,
          maxTokens: 32000,
        });
        await job.withOrg((ctx) => recordUsage(ctx, 'llm_cost_usd', priceUsage(model, usage)));
        distributor = out.distributor ?? distributor;
        const period = { start: out.periodStart, end: out.periodEnd };
        lines = out.lines.map((l) => ({
          periodStart: period.start,
          periodEnd: period.end,
          source: canonicalSource(l.source),
          territory: l.territory,
          isrc: l.isrc?.toUpperCase().replace(/[^A-Z0-9]/g, '') || null,
          upc: l.upc?.replace(/\D/g, '') || null,
          trackTitle: l.trackTitle,
          units: Math.round(l.units),
          grossCents: Math.round((l.grossAmount ?? l.netAmount) * 100),
          netCents: Math.round(l.netAmount * 100),
          currency: out.currency ?? currency,
        }));
      } else {
        throw new Error('Statements must be CSV or PDF');
      }
      if (lines.length === 0) throw new Error('No revenue lines found in the statement');

      await job.withOrg(async (ctx) => {
        // Match lines to the catalogue by ISRC (tracks) and UPC (releases).
        const isrcs = [...new Set(lines.map((l) => l.isrc).filter((x): x is string => Boolean(x)))];
        const upcs = [...new Set(lines.map((l) => l.upc).filter((x): x is string => Boolean(x)))];
        const [trackRows, releaseRows] = await Promise.all([
          isrcs.length ? ctx.tx.select({ id: tracks.id, isrc: tracks.isrc }).from(tracks).where(inArray(tracks.isrc, isrcs)) : [],
          upcs.length ? ctx.tx.select({ id: releases.id, upc: releases.upc }).from(releases).where(inArray(releases.upc, upcs.flatMap((u) => [u, u.padStart(13, '0')]))) : [],
        ]);
        const trackBy = new Map(trackRows.map((t) => [t.isrc!, t.id]));
        const releaseBy = new Map(releaseRows.map((r) => [r.upc!.replace(/^0/, ''), r.id]));
        const unmatched = isrcs.filter((i) => !trackBy.has(i)).length;
        const [prev] = await ctx.tx.select().from(documents).where(and(eq(documents.type, 'statement'), eq(documents.isLatest, true), ne(documents.id, doc.id), eq(documents.extractionStatus, 'done'))).orderBy(desc(documents.createdAt)).limit(1);
        const summary: StatementSummary = summarize(lines, { distributor, unmatchedIsrcs: unmatched, previousNetCents: (prev?.extractedTerms as StatementSummary | null)?.netCents ?? null });
        await ctx.tx.delete(statementLines).where(eq(statementLines.documentId, doc.id));
        for (let i = 0; i < lines.length; i += 1000) {
          await ctx.tx.insert(statementLines).values(
            lines.slice(i, i + 1000).map((l) => ({ ...l, documentId: doc.id, trackId: l.isrc ? trackBy.get(l.isrc) ?? null : null, releaseId: l.upc ? releaseBy.get(l.upc.replace(/^0/, '')) ?? null : null })),
          );
        }
        await ctx.tx.update(documents).set({ extractionStatus: 'done', extractedTerms: summary }).where(eq(documents.id, doc.id));
        await ctx.audit({ action: 'statement.parsed', module: 'documents', targetType: 'document', targetId: doc.id, targetLabel: doc.title, after: { lines: lines.length, netCents: summary.netCents, anomalies: summary.anomalies.length } });
        await ctx.emit('documents.statement.parsed', { documentId: doc.id, lines: lines.length, periodStart: summary.periodStart, periodEnd: summary.periodEnd });
      });
      await publish(job.orgId!, { type: 'documents.extraction.updated', data: { documentId: doc.id, status: 'done' }, permission: 'documents:read_financial' });
    } catch (err) {
      await job.withOrg((ctx) => ctx.tx.update(documents).set({ extractionStatus: 'failed', extractionError: (err as Error).message.slice(0, 500) }).where(eq(documents.id, doc.id)));
      if ((err as { transient?: boolean }).transient) throw err;
    }
  }),

  /** Daily: fan out reminder checks to every label with Documents on. */
  defineJob('documents.reminders', async () => {
    const orgs = await systemDb().select({ id: organizations.id, plan: organizations.plan }).from(organizations);
    for (const o of orgs) {
      if (!(await enabledModuleIds(systemDb(), o)).has('documents')) continue;
      await enqueue('documents.reminders-org', o.id, {}, { jobId: `reminders-${o.id}-${new Date().toISOString().slice(0, 10)}` });
    }
  }),

  defineJob('documents.reminders-org', async (job) => {
    await job.withOrg(async (ctx) => {
      const today = new Date().toISOString().slice(0, 10);
      const due = await ctx.tx
        .select({ k: keyDates, title: documents.title })
        .from(keyDates)
        .innerJoin(documents, eq(documents.id, keyDates.documentId))
        .where(and(isNull(keyDates.dismissedAt), sql`${keyDates.date} >= ${today}::date`, sql`${keyDates.date} <= ${today}::date + interval '120 days'`));
      for (const { k, title } of due) {
        const daysLeft = Math.round((Date.parse(k.date) - Date.parse(today)) / 86400_000);
        // Fire for the tightest reminder threshold we've crossed and haven't announced yet.
        const threshold = [...k.remindDays].sort((a, b) => a - b).find((d) => daysLeft <= d);
        if (threshold === undefined || (k.lastRemindedFor !== null && k.lastRemindedFor <= threshold)) continue;
        await ctx.tx.update(keyDates).set({ lastRemindedFor: threshold }).where(eq(keyDates.id, k.id));
        await ctx.emit('documents.key_date.due', { keyDateId: k.id, documentId: k.documentId, title, date: k.date, daysLeft, kind: k.kind });
      }
      // Signed contracts past their end date become expired.
      await ctx.tx.update(documents).set({ contractStatus: 'expired' }).where(and(eq(documents.type, 'contract'), eq(documents.contractStatus, 'signed'), lt(documents.expiryDate, today)));
    });
  }),
];
