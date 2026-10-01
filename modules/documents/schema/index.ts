import { sql } from 'drizzle-orm';
import { bigint, boolean, date, index, integer, jsonb, pgTable, text, uniqueIndex, uuid, type AnyPgColumn } from 'drizzle-orm/pg-core';
import { orgIdColumn, tenantColumns, ts } from '@labelconsole/core/db/columns';
import { releases, tracks } from '@labelconsole/catalogue/schema';
import { files } from '@labelconsole/drive/schema';

export const DOCUMENT_TYPES = ['contract', 'statement', 'other'] as const;
export type DocumentType = (typeof DOCUMENT_TYPES)[number];
export const CONTRACT_STATUSES = ['draft', 'sent', 'signed', 'expired', 'terminated'] as const;
export type ContractStatus = (typeof CONTRACT_STATUSES)[number];

export type Party = { name: string; role: string; artistId?: string | null };

/** What AI extraction proposes. Never applied until a person confirms. */
export type ContractTerms = {
  agreementType: string | null;
  parties: Party[];
  effectiveDate: string | null;
  termDescription: string | null;
  termEndDate: string | null;
  territory: string | null;
  royaltyArtistPct: number | null;
  royaltyLabelPct: number | null;
  royaltyBasis: string | null;
  advanceAmount: number | null;
  advanceCurrency: string | null;
  recoupment: string | null;
  options: Array<{ description: string; exerciseBy: string | null }>;
  keyDates: Array<{ kind: 'expiry' | 'option' | 'renewal' | 'notice' | 'payment' | 'other'; date: string; description: string }>;
  releasesCovered: string[];
  notes: string | null;
};

export type StatementSummary = {
  distributor: string | null;
  periodStart: string | null;
  periodEnd: string | null;
  currency: string | null;
  lineCount: number;
  grossCents: number;
  netCents: number;
  units: number;
  bySource: Array<{ source: string; netCents: number; units: number }>;
  anomalies: string[];
};

export const documents = pgTable(
  'documents',
  {
    ...tenantColumns(),
    type: text('type').$type<DocumentType>().notNull().default('other'),
    title: text('title').notNull(),
    fileId: uuid('file_id').references(() => files.id, { onDelete: 'set null' }),
    mime: text('mime'),
    size: bigint('size', { mode: 'number' }),
    version: integer('version').notNull().default(1),
    /** Previous version this one replaces. */
    previousId: uuid('previous_id').references((): AnyPgColumn => documents.id, { onDelete: 'set null' }),
    isLatest: boolean('is_latest').notNull().default(true),
    tags: text('tags').array().notNull().default(sql`'{}'::text[]`),
    confidential: boolean('confidential').notNull().default(false),
    contractStatus: text('contract_status').$type<ContractStatus>(),
    parties: jsonb('parties').$type<Party[]>().notNull().default([]),
    /** none | queued | running | done | failed */
    extractionStatus: text('extraction_status').notNull().default('none'),
    extractionError: text('extraction_error'),
    extractedTerms: jsonb('extracted_terms').$type<ContractTerms | StatementSummary>(),
    termsConfirmedAt: ts('terms_confirmed_at'),
    termsConfirmedBy: text('terms_confirmed_by'),
    /** Confirmed terms (copied from extraction after human review, possibly edited). */
    terms: jsonb('terms').$type<ContractTerms>(),
    textContent: text('text_content'),
    signedAt: date('signed_at'),
    effectiveDate: date('effective_date'),
    expiryDate: date('expiry_date'),
  },
  (t) => [index('documents_org_type_idx').on(t.orgId, t.type, t.isLatest), index('documents_org_expiry_idx').on(t.orgId, t.expiryDate)],
);

export const documentLinks = pgTable(
  'document_links',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    orgId: orgIdColumn(),
    documentId: uuid('document_id')
      .notNull()
      .references(() => documents.id, { onDelete: 'cascade' }),
    entityType: text('entity_type').notNull(),
    entityId: uuid('entity_id').notNull(),
    createdAt: ts('created_at').notNull().defaultNow(),
  },
  (t) => [uniqueIndex('document_links_uniq').on(t.documentId, t.entityType, t.entityId), index('document_links_entity_idx').on(t.orgId, t.entityType, t.entityId)],
);

export const keyDates = pgTable(
  'document_key_dates',
  {
    ...tenantColumns(),
    documentId: uuid('document_id')
      .notNull()
      .references(() => documents.id, { onDelete: 'cascade' }),
    kind: text('kind').notNull(),
    date: date('date').notNull(),
    description: text('description').notNull(),
    /** Days before the date to remind, e.g. {90, 30, 7}. */
    remindDays: integer('remind_days').array().notNull().default(sql`'{90,30,7}'::int[]`),
    lastRemindedFor: integer('last_reminded_for'),
    dismissedAt: ts('dismissed_at'),
  },
  (t) => [index('document_key_dates_org_date_idx').on(t.orgId, t.date)],
);

/** Parsed distributor statement rows: the label's ground truth for counts and money. */
export const statementLines = pgTable(
  'statement_lines',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    orgId: orgIdColumn(),
    documentId: uuid('document_id')
      .notNull()
      .references(() => documents.id, { onDelete: 'cascade' }),
    periodStart: date('period_start'),
    periodEnd: date('period_end'),
    source: text('source').notNull(),
    territory: text('territory'),
    isrc: text('isrc'),
    upc: text('upc'),
    trackTitle: text('track_title'),
    trackId: uuid('track_id').references(() => tracks.id, { onDelete: 'set null' }),
    releaseId: uuid('release_id').references(() => releases.id, { onDelete: 'set null' }),
    units: bigint('units', { mode: 'number' }).notNull().default(0),
    grossCents: bigint('gross_cents', { mode: 'number' }).notNull().default(0),
    netCents: bigint('net_cents', { mode: 'number' }).notNull().default(0),
    currency: text('currency').notNull().default('USD'),
    createdAt: ts('created_at').notNull().defaultNow(),
  },
  (t) => [index('statement_lines_doc_idx').on(t.orgId, t.documentId), index('statement_lines_track_idx').on(t.orgId, t.trackId, t.periodEnd)],
);

export const documentAccessLog = pgTable(
  'document_access_log',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    orgId: orgIdColumn(),
    documentId: uuid('document_id')
      .notNull()
      .references(() => documents.id, { onDelete: 'cascade' }),
    actor: text('actor').notNull(),
    action: text('action').notNull(),
    ip: text('ip'),
    createdAt: ts('created_at').notNull().defaultNow(),
  },
  (t) => [index('document_access_log_doc_idx').on(t.orgId, t.documentId, t.createdAt)],
);

export type Document = typeof documents.$inferSelect;
export type KeyDate = typeof keyDates.$inferSelect;
export type StatementLine = typeof statementLines.$inferSelect;
