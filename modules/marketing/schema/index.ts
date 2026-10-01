import { sql } from 'drizzle-orm';
import { bigint, date, index, integer, jsonb, pgTable, text, uuid } from 'drizzle-orm/pg-core';
import { tenantColumns, ts } from '@labelconsole/core/db/columns';
import { releases, tracks } from '@labelconsole/catalogue/schema';
import { contacts, playlists } from '@labelconsole/network/schema';

export const CAMPAIGN_STATUSES = ['planning', 'active', 'paused', 'completed', 'cancelled'] as const;
export type CampaignStatus = (typeof CAMPAIGN_STATUSES)[number];
export type Kpi = { name: string; target: number; unit: string; metric?: 'streams' | 'views' | 'posts' | 'adds' | 'custom'; /** Entered by hand for custom KPIs; the others are measured. */ actual?: number | null };

export const campaigns = pgTable(
  'campaigns',
  {
    ...tenantColumns(),
    name: text('name').notNull(),
    releaseId: uuid('release_id').references(() => releases.id, { onDelete: 'set null' }),
    goals: text('goals'),
    budgetCents: bigint('budget_cents', { mode: 'number' }).notNull().default(0),
    currency: text('currency').notNull().default('USD'),
    kpis: jsonb('kpis').$type<Kpi[]>().notNull().default([]),
    startDate: date('start_date'),
    endDate: date('end_date'),
    status: text('status').$type<CampaignStatus>().notNull().default('planning'),
    ownerId: uuid('owner_id'),
  },
  (t) => [index('campaigns_org_status_idx').on(t.orgId, t.status)],
);

export type Stage = { id: string; name: string };
export const DEFAULT_CREATOR_STAGES: Stage[] = [
  { id: 'prospect', name: 'Prospect' },
  { id: 'offered', name: 'Offered' },
  { id: 'booked', name: 'Booked' },
  { id: 'posted', name: 'Posted' },
  { id: 'paid', name: 'Paid' },
];

export const boards = pgTable(
  'pipeline_boards',
  {
    ...tenantColumns(),
    name: text('name').notNull(),
    /** creator | editor | playlist | custom */
    kind: text('kind').notNull().default('creator'),
    campaignId: uuid('campaign_id').references(() => campaigns.id, { onDelete: 'cascade' }),
    stages: jsonb('stages').$type<Stage[]>().notNull().default(DEFAULT_CREATOR_STAGES),
  },
  (t) => [index('pipeline_boards_org_idx').on(t.orgId, t.campaignId)],
);

/**
 * A card on a pipeline board. For creator boards it is a booking: what was
 * offered and paid, how many posts were ordered and delivered, and the proof.
 */
export const cards = pgTable(
  'pipeline_cards',
  {
    ...tenantColumns(),
    boardId: uuid('board_id')
      .notNull()
      .references(() => boards.id, { onDelete: 'cascade' }),
    stage: text('stage').notNull(),
    position: integer('position').notNull().default(0),
    title: text('title').notNull(),
    contactId: uuid('contact_id').references(() => contacts.id, { onDelete: 'set null' }),
    campaignId: uuid('campaign_id').references(() => campaigns.id, { onDelete: 'set null' }),
    dueDate: date('due_date'),
    ownerId: uuid('owner_id'),
    offerCents: bigint('offer_cents', { mode: 'number' }),
    paidCents: bigint('paid_cents', { mode: 'number' }),
    paidAt: ts('paid_at'),
    deliverablesOrdered: integer('deliverables_ordered').notNull().default(0),
    deliverablesDelivered: integer('deliverables_delivered').notNull().default(0),
    proofUrls: text('proof_urls').array().notNull().default(sql`'{}'::text[]`),
    /** Views measured on the delivered posts, when known. */
    measuredViews: bigint('measured_views', { mode: 'number' }),
    notes: text('notes'),
  },
  (t) => [index('pipeline_cards_board_idx').on(t.orgId, t.boardId, t.stage, t.position), index('pipeline_cards_campaign_idx').on(t.orgId, t.campaignId)],
);

export const PITCH_STATUSES = ['draft', 'approved', 'sending', 'sent', 'opened', 'replied', 'accepted', 'declined'] as const;

/** Playlist / editor outreach tracker. */
export const pitches = pgTable(
  'outreach_pitches',
  {
    ...tenantColumns(),
    campaignId: uuid('campaign_id').references(() => campaigns.id, { onDelete: 'set null' }),
    contactId: uuid('contact_id')
      .notNull()
      .references(() => contacts.id, { onDelete: 'cascade' }),
    playlistId: uuid('playlist_id').references(() => playlists.id, { onDelete: 'set null' }),
    trackId: uuid('track_id').references(() => tracks.id, { onDelete: 'set null' }),
    status: text('status').notNull().default('draft'),
    subject: text('subject'),
    body: text('body'),
    sentAt: ts('sent_at'),
    repliedAt: ts('replied_at'),
    outcome: text('outcome'),
    agentRunId: uuid('agent_run_id'),
  },
  (t) => [index('outreach_pitches_org_idx').on(t.orgId, t.campaignId, t.status)],
);

export type SketchItem = {
  id: string;
  type: 'note' | 'ref' | 'milestone';
  x: number;
  y: number;
  w: number;
  h: number;
  text: string;
  url?: string;
  date?: string;
  color?: 'paper' | 'blue' | 'ink' | 'red';
};

export const sketchboards = pgTable(
  'sketchboards',
  {
    ...tenantColumns(),
    name: text('name').notNull(),
    campaignId: uuid('campaign_id').references(() => campaigns.id, { onDelete: 'cascade' }),
    canvas: jsonb('canvas').$type<{ items: SketchItem[] }>().notNull().default({ items: [] }),
    collaborators: uuid('collaborators').array().notNull().default(sql`'{}'::uuid[]`),
    version: integer('version').notNull().default(1),
  },
  (t) => [index('sketchboards_org_idx').on(t.orgId, t.campaignId)],
);

export type Campaign = typeof campaigns.$inferSelect;
export type Board = typeof boards.$inferSelect;
export type Card = typeof cards.$inferSelect;
export type Pitch = typeof pitches.$inferSelect;
export type Sketchboard = typeof sketchboards.$inferSelect;
