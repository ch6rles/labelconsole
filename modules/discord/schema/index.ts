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
    createdAt: ts('created_at').notNull().defaultNow(),
  },
  (t) => [index('discord_lookups_org_time_idx').on(t.orgId, t.createdAt)],
);

export type DiscordCorrection = typeof discordCorrections.$inferSelect;
