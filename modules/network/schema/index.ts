import { sql } from 'drizzle-orm';
import { bigint, index, integer, jsonb, pgTable, text, uuid } from 'drizzle-orm/pg-core';
import { tenantColumns, ts } from '@labelconsole/core/db/columns';

export const CONTACT_TYPES = ['creator', 'editor', 'curator', 'press', 'other'] as const;
export type ContactType = (typeof CONTACT_TYPES)[number];
export const CONTACT_STAGES = ['lead', 'contacted', 'engaged', 'active', 'dormant', 'do_not_contact'] as const;
export type ContactStage = (typeof CONTACT_STAGES)[number];

export type Handles = Partial<Record<'instagram' | 'tiktok' | 'youtube' | 'x' | 'spotify' | 'twitch' | 'website', string>>;

export const contacts = pgTable(
  'contacts',
  {
    ...tenantColumns(),
    type: text('type').$type<ContactType>().notNull().default('creator'),
    name: text('name').notNull(),
    email: text('email'),
    organization: text('organization'),
    handles: jsonb('handles').$type<Handles>().notNull().default({}),
    audienceSize: bigint('audience_size', { mode: 'number' }),
    genres: text('genres').array().notNull().default(sql`'{}'::text[]`),
    /** Typical rate per post / placement, in minor units. */
    rateCents: integer('rate_cents'),
    currency: text('currency').notNull().default('USD'),
    stage: text('stage').$type<ContactStage>().notNull().default('lead'),
    country: text('country'),
    /** Where to pay them; null means no payout address on file. */
    payoutEmail: text('payout_email'),
    /** Someone checked the account exists and is who it claims. */
    verifiedAt: ts('verified_at'),
    /** The platform account no longer exists. Kept so past spend stays auditable. */
    goneAt: ts('gone_at'),
    notes: text('notes'),
    lastContactedAt: ts('last_contacted_at'),
  },
  (t) => [index('contacts_org_type_idx').on(t.orgId, t.type), index('contacts_org_name_idx').on(t.orgId, t.name)],
);

export const interactions = pgTable(
  'interactions',
  {
    ...tenantColumns(),
    contactId: uuid('contact_id')
      .notNull()
      .references(() => contacts.id, { onDelete: 'cascade' }),
    /** email | dm | call | meeting | note */
    channel: text('channel').notNull(),
    /** inbound | outbound */
    direction: text('direction').notNull().default('outbound'),
    summary: text('summary').notNull(),
    campaignId: uuid('campaign_id'),
    agentRunId: uuid('agent_run_id'),
    occurredAt: ts('occurred_at').notNull().defaultNow(),
  },
  (t) => [index('interactions_contact_idx').on(t.orgId, t.contactId, t.occurredAt)],
);

/** Playlists curated by a contact, for playlist outreach. */
export const playlists = pgTable(
  'playlists',
  {
    ...tenantColumns(),
    contactId: uuid('contact_id').references(() => contacts.id, { onDelete: 'set null' }),
    platform: text('platform').notNull(),
    name: text('name').notNull(),
    url: text('url'),
    externalId: text('external_id'),
    followers: bigint('followers', { mode: 'number' }),
    genres: text('genres').array().notNull().default(sql`'{}'::text[]`),
  },
  (t) => [index('playlists_org_idx').on(t.orgId, t.platform)],
);

export type Contact = typeof contacts.$inferSelect;
export type Interaction = typeof interactions.$inferSelect;
export type Playlist = typeof playlists.$inferSelect;
