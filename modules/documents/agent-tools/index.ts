import { z } from 'zod';
import { compact, defineTool } from '@labelconsole/core/tools';
import type { StatementSummary } from '../schema';
import * as svc from '../service';

export const tools = [
  defineTool({
    name: 'documents_read',
    module: 'documents',
    description: 'Read a document: its type, status, linked artists and releases, confirmed or proposed terms, key dates, and (for contracts) the extracted text. Confidential documents need the confidential permission.',
    input: z.object({ id: z.uuid() }),
    permission: 'documents:read',
    risk: 'read',
    idempotent: true,
    execute: (t, i) =>
      t.withOrg(async (ctx) => {
        const d = await svc.getDocument(ctx, i.id);
        return compact({
          id: d.document.id,
          title: d.document.title,
          type: d.document.type,
          contractStatus: d.document.contractStatus,
          artists: d.artists.map((a) => a.name),
          releases: d.releases.map((r) => r.title),
          confirmedTerms: d.document.terms,
          proposedTerms: d.document.termsConfirmedAt ? undefined : d.document.extractedTerms,
          keyDates: d.keyDates.map((k) => ({ kind: k.kind, date: k.date, description: k.description })),
          text: d.document.textContent?.slice(0, 15_000) ?? null,
        });
      }),
  }),
  defineTool({
    name: 'documents_extract_terms',
    module: 'documents',
    description: 'Queue (re-)extraction of contract terms or statement lines for a document. Results arrive asynchronously and must be confirmed by a person before they apply.',
    input: z.object({ id: z.uuid() }),
    permission: 'documents:write',
    risk: 'write',
    idempotent: true,
    preview: (i) => `Re-run extraction for document ${i.id}`,
    execute: (t, i) => t.withOrg((ctx) => svc.requestExtraction(ctx, i.id)),
  }),
  defineTool({
    name: 'documents_summarize_statement',
    module: 'documents',
    description: 'Summarise an imported distributor statement: period, totals, revenue by store, and anomalies (negative lines, unmatched ISRCs, duplicates, big swings). Omit id for the latest statement.',
    input: z.object({ id: z.uuid().optional() }),
    permission: 'documents:read_financial',
    risk: 'read',
    idempotent: true,
    execute: (t, i) =>
      t.withOrg(async (ctx) => {
        if (i.id) {
          const d = await svc.getDocument(ctx, i.id);
          return { id: d.document.id, title: d.document.title, status: d.document.extractionStatus, summary: d.document.extractedTerms as StatementSummary | null };
        }
        const latest = await svc.latestStatementSummary(ctx);
        return latest ? { id: latest.document.id, title: latest.document.title, summary: latest.summary } : { found: false };
      }),
  }),
  defineTool({
    name: 'documents_upcoming_dates',
    module: 'documents',
    description: 'Contract dates coming up (option windows, expiries, notice periods, renewals) within N days, plus live releases whose artist has no signed contract.',
    input: z.object({ withinDays: z.number().int().min(1).max(365).default(90) }),
    permission: 'documents:read',
    risk: 'read',
    idempotent: true,
    execute: (t, i) =>
      t.withOrg(async (ctx) => ({
        keyDates: (await svc.upcomingKeyDates(ctx, i.withinDays)).map((k) => ({ document: k.title, documentId: k.documentId, kind: k.keyDate.kind, date: k.keyDate.date, description: k.keyDate.description })),
        liveReleasesOnUnsignedPaper: (await svc.liveReleasesOnUnsignedPaper(ctx)).map((r) => ({ release: r.title, artist: r.artistName })),
      })),
  }),
];
