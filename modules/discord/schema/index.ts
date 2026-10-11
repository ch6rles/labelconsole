import { bigint, boolean, index, integer, jsonb, pgTable, text, uniqueIndex, uuid } from 'drizzle-orm/pg-core';
import { orgIdColumn, tenantColumns, ts } from '@labelconsole/core/db/columns';

/** A member's Discord account. One per member, and a Discord account links to one member per label. */
export const discordLinks = pgTable(
  'discord_links',
  {
    ...tenantColumns(),
    userId: uuid('user_id').notNull(),
    discordUserId: text('discord_user_id').notNull(),
    /** Display only: the Discord username when the account was linked. */
    discordUsername: text('discord_username').notNull(),
    lastUsedAt: ts('last_used_at'),
  },
  (t) => [uniqueIndex('discord_links_user_idx').on(t.orgId, t.userId), uniqueIndex('discord_links_discord_idx').on(t.orgId, t.discordUserId)],
);

/**
 * One-time codes a member types into /link. Only an HMAC of the code is
 * stored; a code lasts ten minutes and works once.
 */
export const discordLinkCodes = pgTable(
  'discord_link_codes',
  {
    ...tenantColumns(),
    userId: uuid('user_id').notNull(),
    codeHash: text('code_hash').notNull().unique(),
    expiresAt: ts('expires_at').notNull(),
    usedAt: ts('used_at'),
  },
  (t) => [index('discord_link_codes_user_idx').on(t.orgId, t.userId)],
);

/** The last attempt to register the slash commands with Discord. */
export const discordState = pgTable(
  'discord_state',
  {
    ...tenantColumns(),
    applicationId: text('application_id'),
    commandsRegisteredAt: ts('commands_registered_at'),
    commandsError: text('commands_error'),
    /** Whether members may post a card in a channel for everyone (share:true). Replies are private otherwise. */
    allowSharing: boolean('allow_sharing').notNull().default(true),
    /** On shared cards: show the distributor card. */
    shareDistributor: boolean('share_distributor').notNull().default(true),
    /** On shared cards: show the stream count. */
    shareStreams: boolean('share_streams').notNull().default(true),
    /** How many songs looked up in Discord get a daily play-count reading (0 = off). Each is one billed SpotScraper request a day. */
    dailyReadings: integer('daily_readings').notNull().default(0),
  },
  (t) => [uniqueIndex('discord_state_org_idx').on(t.orgId)],
);

export type DiscordLink = typeof discordLinks.$inferSelect;

/**
 * Corrections suggested from Discord (/correct or Report / Correct). Nothing
 * changes until someone with catalogue:write approves; an approved correction
 * is shown on cards as a reviewed value, with the sources' values kept beside it.
 */
export const discordCorrections = pgTable(
  'discord_corrections',
  {
    ...tenantColumns(),
    /** `isrc:<ISRC>` or `upc:<UPC>`. */
    ref: text('ref').notNull(),
    /** Title of the song or release when the correction was made, for the review list. */
    subject: text('subject').notNull(),
    field: text('field').notNull(),
    /** What the card showed, for comparison. */
    currentValue: text('current_value'),
    proposedValue: text('proposed_value').notNull(),
    note: text('note'),
    /** pending | approved | rejected */
    status: text('status').notNull().default('pending'),
    submittedBy: uuid('submitted_by').notNull(),
    reviewedBy: uuid('reviewed_by'),
    reviewedAt: ts('reviewed_at'),
    reviewNote: text('review_note'),
  },
  (t) => [index('discord_corrections_ref_idx').on(t.orgId, t.ref, t.status), index('discord_corrections_status_idx').on(t.orgId, t.status, t.createdAt)],
);

/**
 * A platform's public play count, kept each time a song is looked up, so any
 * song gets a history of real readings (nothing between them is filled in).
 */
export const discordPlayReadings = pgTable(
  'discord_play_readings',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    orgId: orgIdColumn(),
    isrc: text('isrc').notNull(),
    platform: text('platform').notNull(),
    source: text('source').notNull(),
    count: bigint('count', { mode: 'number' }).notNull(),
    capturedAt: ts('captured_at').notNull().defaultNow(),
  },
  (t) => [index('discord_play_readings_isrc_idx').on(t.orgId, t.isrc, t.capturedAt)],
);

/** One row per command or button, for launch metrics: outcome, timing, cache use and what was found. */
export const discordLookups = pgTable(
  'discord_lookups',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    orgId: orgIdColumn(),
    userId: uuid('user_id'),
    command: text('command').notNull(),
    /** link | isrc | upc | text | button | other */
    inputKind: text('input_kind').notNull(),
    /** card | picker | not_found | notice | error */
    outcome: text('outcome').notNull(),
    ref: text('ref'),
    cached: boolean('cached').notNull().default(false),
    durationMs: integer('duration_ms').notNull(),
    /** Which fields the card had, and how they were known. */
    coverage: jsonb('coverage').$type<Record<string, string>>(),
    /** For fresh lookups: how each source call ended and how long it took. */
    sources: jsonb('sources').$type<SourceCall[]>(),
    createdAt: ts('created_at').notNull().defaultNow(),
  },
  (t) => [index('discord_lookups_org_time_idx').on(t.orgId, t.createdAt)],
);

export type SourceCall = { source: string; outcome: string; ms: number | null };

/**
 * What each source has said about a song or release, field by field, as
 * published. Append-only in spirit: a new value is a new row, and seeing the
 * same value again only moves `last_seen_at`, so changes over time (a new
 * label, a re-delivered release) stay visible. Corrections never touch it.
 */
export const discordEvidence = pgTable(
  'discord_evidence',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    orgId: orgIdColumn(),
    /** `isrc:<ISRC>` for recording fields, `upc:<UPC>` for release fields. */
    ref: text('ref').notNull(),
    field: text('field').notNull(),
    source: text('source').notNull(),
    value: text('value').notNull(),
    /** The source's own page for the record, when it has one. */
    sourceUrl: text('source_url'),
    firstSeenAt: ts('first_seen_at').notNull().defaultNow(),
    lastSeenAt: ts('last_seen_at').notNull().defaultNow(),
  },
  (t) => [uniqueIndex('discord_evidence_claim_idx').on(t.orgId, t.ref, t.field, t.source, t.value), index('discord_evidence_seen_idx').on(t.orgId, t.lastSeenAt)],
);

export type BenchmarkCounts = { reported: number; checked: number; agreed: number };
export type BenchmarkResult = {
  items: number;
  sources: Array<{ source: string; outcomes: Record<string, number>; p50: number | null; p95: number | null; fields: Record<string, BenchmarkCounts> }>;
  /** The merged card, as Discord shows it. */
  merged: Record<string, BenchmarkCounts>;
  /** The inferred distributor against distributors your catalogue records as confirmed. */
  distributor: { checked: number; agreed: number; unknown: number };
  billed: { spotscraper: number };
  /** The first disagreements, to look at by hand. */
  misses: Array<{ isrc: string; title: string; field: string; source: string; ours: string; theirs: string }>;
};

/** A source benchmark: the label's own songs looked up through every source and checked against its catalogue. */
export const discordBenchmarks = pgTable(
  'discord_benchmarks',
  {
    ...tenantColumns(),
    requestedBy: uuid('requested_by'),
    /** queued | running | done | failed */
    status: text('status').notNull().default('queued'),
    sample: integer('sample').notNull(),
    /** Whether billed sources (SpotScraper) were included. */
    includeBilled: boolean('include_billed').notNull().default(false),
    progress: integer('progress').notNull().default(0),
    results: jsonb('results').$type<BenchmarkResult>(),
    error: text('error'),
    finishedAt: ts('finished_at'),
  },
  (t) => [index('discord_benchmarks_org_idx').on(t.orgId, t.createdAt)],
);

export type DiscordCorrection = typeof discordCorrections.$inferSelect;
