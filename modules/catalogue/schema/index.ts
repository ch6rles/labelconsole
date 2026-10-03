import { sql } from 'drizzle-orm';
import { boolean, date, index, integer, jsonb, numeric, pgTable, text, uniqueIndex, uuid } from 'drizzle-orm/pg-core';
import { orgIdColumn, tenantColumns, ts } from '@labelconsole/core/db/columns';
import { artists } from '@labelconsole/people/schema';

export const RELEASE_TYPES = ['single', 'ep', 'album', 'compilation'] as const;
export const RELEASE_STATUSES = ['collecting', 'draft', 'scheduled', 'live', 'taken_down'] as const;
export type ReleaseType = (typeof RELEASE_TYPES)[number];
export type ReleaseStatus = (typeof RELEASE_STATUSES)[number];

export type ChecklistItem = { id: string; label: string; done: boolean; doneAt?: string | null };

export const releases = pgTable(
  'releases',
  {
    ...tenantColumns(),
    title: text('title').notNull(),
    type: text('type').$type<ReleaseType>().notNull().default('single'),
    upc: text('upc'),
    catalogNumber: text('catalog_number'),
    releaseDate: date('release_date'),
    labelName: text('label_name'),
    distributor: text('distributor'),
    distributorConfidence: numeric('distributor_confidence', { precision: 4, scale: 3 }),
    distributorEvidence: jsonb('distributor_evidence').$type<DistributorEvidence[]>(),
    status: text('status').$type<ReleaseStatus>().notNull().default('collecting'),
    artworkFileId: uuid('artwork_file_id'),
    pLine: text('p_line'),
    cLine: text('c_line'),
    genre: text('genre'),
    notes: text('notes'),
    /** Created from the public intake link and not yet promoted. */
    intake: boolean('intake').notNull().default(false),
    checklist: jsonb('checklist').$type<ChecklistItem[]>().notNull().default([]),
  },
  (t) => [index('releases_org_date_idx').on(t.orgId, t.releaseDate), uniqueIndex('releases_org_upc_idx').on(t.orgId, t.upc)],
);

export const releaseArtists = pgTable(
  'release_artists',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    orgId: orgIdColumn(),
    releaseId: uuid('release_id')
      .notNull()
      .references(() => releases.id, { onDelete: 'cascade' }),
    artistId: uuid('artist_id')
      .notNull()
      .references(() => artists.id, { onDelete: 'cascade' }),
    role: text('role').notNull().default('primary'),
    position: integer('position').notNull().default(0),
  },
  (t) => [uniqueIndex('release_artists_uniq').on(t.releaseId, t.artistId), index('release_artists_artist_idx').on(t.orgId, t.artistId)],
);

export const TRACK_STATUSES = ['draft', 'ready'] as const;

export const tracks = pgTable(
  'tracks',
  {
    ...tenantColumns(),
    title: text('title').notNull(),
    isrc: text('isrc'),
    durationMs: integer('duration_ms'),
    version: text('version'),
    explicit: boolean('explicit').notNull().default(false),
    genre: text('genre'),
    bpm: integer('bpm'),
    musicalKey: text('musical_key'),
    language: text('language'),
    audioFileId: uuid('audio_file_id'),
    status: text('status').notNull().default('draft'),
    /** What still blocks delivery (missing audio, credits, splits...), recomputed on change. */
    blockers: text('blockers').array().notNull().default(sql`'{}'::text[]`),
  },
  (t) => [uniqueIndex('tracks_org_isrc_idx').on(t.orgId, t.isrc), index('tracks_org_title_idx').on(t.orgId, t.title)],
);

export const releaseTracks = pgTable(
  'release_tracks',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    orgId: orgIdColumn(),
    releaseId: uuid('release_id')
      .notNull()
      .references(() => releases.id, { onDelete: 'cascade' }),
    trackId: uuid('track_id')
      .notNull()
      .references(() => tracks.id, { onDelete: 'cascade' }),
    disc: integer('disc').notNull().default(1),
    position: integer('position').notNull().default(1),
  },
  (t) => [uniqueIndex('release_tracks_uniq').on(t.releaseId, t.trackId), index('release_tracks_track_idx').on(t.orgId, t.trackId)],
);

export const trackArtists = pgTable(
  'track_artists',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    orgId: orgIdColumn(),
    trackId: uuid('track_id')
      .notNull()
      .references(() => tracks.id, { onDelete: 'cascade' }),
    artistId: uuid('artist_id')
      .notNull()
      .references(() => artists.id, { onDelete: 'cascade' }),
    role: text('role').notNull().default('primary'),
  },
  (t) => [uniqueIndex('track_artists_uniq').on(t.trackId, t.artistId), index('track_artists_artist_idx').on(t.orgId, t.artistId)],
);

export const credits = pgTable(
  'credits',
  {
    ...tenantColumns(),
    trackId: uuid('track_id')
      .notNull()
      .references(() => tracks.id, { onDelete: 'cascade' }),
    name: text('name').notNull(),
    role: text('role').notNull(),
    artistId: uuid('artist_id'),
  },
  (t) => [index('credits_track_idx').on(t.orgId, t.trackId)],
);

/** A split sheet: who owns what share of a track's master or publishing. */
export const splitSheets = pgTable(
  'split_sheets',
  {
    ...tenantColumns(),
    trackId: uuid('track_id')
      .notNull()
      .references(() => tracks.id, { onDelete: 'cascade' }),
    /** master | publishing */
    kind: text('kind').notNull().default('master'),
    /** draft | sent | partly_signed | signed */
    status: text('status').notNull().default('draft'),
    sentAt: ts('sent_at'),
  },
  (t) => [uniqueIndex('split_sheets_track_kind_idx').on(t.trackId, t.kind)],
);

export const splitParties = pgTable(
  'split_parties',
  {
    ...tenantColumns(),
    sheetId: uuid('sheet_id')
      .notNull()
      .references(() => splitSheets.id, { onDelete: 'cascade' }),
    name: text('name').notNull(),
    email: text('email'),
    artistId: uuid('artist_id'),
    sharePct: numeric('share_pct', { precision: 6, scale: 3 }).notNull(),
    signedAt: ts('signed_at'),
  },
  (t) => [index('split_parties_sheet_idx').on(t.sheetId)],
);

/** Versions, stems, artwork, videos attached to releases, tracks or demos. */
export const assets = pgTable(
  'catalogue_assets',
  {
    ...tenantColumns(),
    ownerType: text('owner_type').notNull(),
    ownerId: uuid('owner_id').notNull(),
    kind: text('kind').notNull(),
    fileId: uuid('file_id').notNull(),
    name: text('name').notNull(),
    version: text('version'),
  },
  (t) => [index('catalogue_assets_owner_idx').on(t.orgId, t.ownerType, t.ownerId)],
);

export const DEMO_STAGES = ['new', 'reviewing', 'shortlisted', 'passed', 'signed'] as const;
export type DemoStage = (typeof DEMO_STAGES)[number];
export type DemoScore = { overall: number; fit: number; production: number; potential: number; rationale: string; scoredBy: string; scoredAt: string };

export const demos = pgTable(
  'demos',
  {
    ...tenantColumns(),
    title: text('title').notNull(),
    artistName: text('artist_name').notNull(),
    submitterName: text('submitter_name'),
    submitterEmail: text('submitter_email'),
    audioFileId: uuid('audio_file_id'),
    links: text('links').array().notNull().default(sql`'{}'::text[]`),
    genre: text('genre'),
    notes: text('notes'),
    score: numeric('score', { precision: 4, scale: 1 }),
    scoreDetail: jsonb('score_detail').$type<DemoScore>(),
    stage: text('stage').$type<DemoStage>().notNull().default('new'),
    reviewedBy: text('reviewed_by'),
    reviewedAt: ts('reviewed_at'),
    /** intake | manual | agent */
    source: text('source').notNull().default('manual'),
  },
  (t) => [index('demos_org_stage_idx').on(t.orgId, t.stage, t.createdAt)],
);

export const PLATFORMS = ['spotify', 'apple', 'deezer', 'youtube', 'musicbrainz', 'tidal', 'amazon', 'licensed'] as const;
export type Platform = (typeof PLATFORMS)[number];

/** A track or release's identity on an external platform, with how we know. */
export const platformIdentities = pgTable(
  'platform_identities',
  {
    ...tenantColumns(),
    entityType: text('entity_type').notNull(),
    entityId: uuid('entity_id').notNull(),
    platform: text('platform').notNull(),
    externalId: text('external_id').notNull(),
    url: text('url'),
    /** 0..1 */
    confidence: numeric('confidence', { precision: 4, scale: 3 }).notNull().default('1'),
    source: text('source').notNull(),
    /** confirmed | pending_review | rejected */
    status: text('status').notNull().default('confirmed'),
    /** youtube: topic | official | ugc */
    variant: text('variant'),
    reviewedBy: text('reviewed_by'),
  },
  (t) => [
    uniqueIndex('platform_identities_uniq').on(t.orgId, t.entityType, t.entityId, t.platform, t.externalId),
    index('platform_identities_entity_idx').on(t.orgId, t.entityType, t.entityId),
    index('platform_identities_status_idx').on(t.orgId, t.status),
  ],
);

export type DistributorEvidence = { source: string; signal: string; value: string; weight: number; distributor: string };

export type ImportMeta = { artistId?: string; artistName?: string; spotifyArtistId?: string; onlyLabel?: boolean; skipped?: number; found?: number; alreadyInCatalogue?: number; error?: string };

export type ResolvedMetadata = {
  input: Record<string, string>;
  isrc: string | null;
  upc: string | null;
  title: string | null;
  artists: string[];
  releaseTitle: string | null;
  releaseType: string | null;
  releaseDate: string | null;
  labelName: string | null;
  pLine: string | null;
  cLine: string | null;
  durationMs: number | null;
  explicit: boolean | null;
  tracks: Array<{ title: string; isrc: string | null; durationMs: number | null; position: number; explicit: boolean | null; artists: string[]; spotifyId?: string | null }>;
  platformIds: Array<{ platform: string; entity: 'track' | 'release'; externalId: string; url: string | null; source: string }>;
  distributor: { name: string | null; confidence: number; evidence: DistributorEvidence[] };
  conflicts: Array<{ field: string; values: Array<{ source: string; value: string }> }>;
  sources: Array<{ source: string; ok: boolean; error?: string; skipped?: string }>;
};

export const metadataLookups = pgTable(
  'metadata_lookups',
  {
    ...tenantColumns(),
    input: jsonb('input').$type<Record<string, string>>().notNull(),
    /** queued | running | done | failed | confirmed */
    status: text('status').notNull().default('queued'),
    result: jsonb('result').$type<ResolvedMetadata>(),
    error: text('error'),
    releaseId: uuid('release_id'),
    importId: uuid('import_id'),
  },
  (t) => [index('metadata_lookups_org_idx').on(t.orgId, t.createdAt)],
);

export const imports = pgTable(
  'catalogue_imports',
  {
    ...tenantColumns(),
    kind: text('kind').notNull(),
    /** queued | running | done | failed */
    status: text('status').notNull().default('queued'),
    total: integer('total').notNull().default(0),
    processed: integer('processed').notNull().default(0),
    succeeded: integer('succeeded').notNull().default(0),
    failed: integer('failed').notNull().default(0),
    items: jsonb('items').$type<Array<{ value: string; status: string; releaseId?: string; error?: string }>>().notNull().default([]),
    /** Create records automatically (true) or stop at review (false). */
    autoConfirm: boolean('auto_confirm').notNull().default(false),
    /** For a Spotify sync (kind "spotify"): the roster artist and whether only the label's own releases are wanted. */
    meta: jsonb('meta').$type<ImportMeta>().notNull().default({}),
  },
  (t) => [index('catalogue_imports_org_idx').on(t.orgId, t.createdAt)],
);

/** Global reference table: distributor names and the label strings they put on releases. */
export const distributorAliases = pgTable(
  'distributor_aliases',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    distributor: text('distributor').notNull(),
    pattern: text('pattern').notNull(),
    weight: numeric('weight', { precision: 4, scale: 3 }).notNull().default('0.6'),
  },
  (t) => [uniqueIndex('distributor_aliases_uniq').on(t.distributor, t.pattern)],
);

/** Per-label learned mappings: UPC company prefixes and label strings confirmed by staff. */
export const distributorHints = pgTable(
  'distributor_hints',
  {
    ...tenantColumns(),
    /** upc_prefix | label_string */
    kind: text('kind').notNull(),
    value: text('value').notNull(),
    distributor: text('distributor').notNull(),
    confirmations: integer('confirmations').notNull().default(1),
  },
  (t) => [uniqueIndex('distributor_hints_uniq').on(t.orgId, t.kind, t.value, t.distributor)],
);

export type Release = typeof releases.$inferSelect;
export type Track = typeof tracks.$inferSelect;
export type Demo = typeof demos.$inferSelect;
export type PlatformIdentity = typeof platformIdentities.$inferSelect;
