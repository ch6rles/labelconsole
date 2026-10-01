import { bigint, boolean, date, index, integer, numeric, pgTable, primaryKey, text, uniqueIndex, uuid } from 'drizzle-orm/pg-core';
import { orgIdColumn, tenantColumns, ts } from '@labelconsole/core/db/columns';
import { tracks } from '@labelconsole/catalogue/schema';

/** Track registry: every catalogue track the tracker polls, with its schedule tier. */
export const streamTracks = pgTable(
  'stream_tracks',
  {
    ...tenantColumns(),
    trackId: uuid('track_id')
      .notNull()
      .references(() => tracks.id, { onDelete: 'cascade' }),
    isrc: text('isrc'),
    /** active (in a live campaign / recent release) | catalogue */
    tier: text('tier').notNull().default('catalogue'),
    /** pending_match | tracking | paused */
    status: text('status').notNull().default('pending_match'),
    nextPollAt: ts('next_poll_at'),
    lastPolledAt: ts('last_polled_at'),
    lastResolvedAt: ts('last_resolved_at'),
    lastError: text('last_error'),
  },
  (t) => [uniqueIndex('stream_tracks_track_idx').on(t.orgId, t.trackId), index('stream_tracks_due_idx').on(t.nextPollAt)],
);

export const STREAM_SOURCES = ['youtube-data-api', 'licensed-provider', 'statement-import'] as const;
export type StreamSource = (typeof STREAM_SOURCES)[number];

/** Daily rollup per track/platform/source for charts and deltas. */
export const streamDaily = pgTable(
  'stream_daily',
  {
    orgId: orgIdColumn(),
    trackId: uuid('track_id')
      .notNull()
      .references(() => tracks.id, { onDelete: 'cascade' }),
    platform: text('platform').notNull(),
    source: text('source').notNull(),
    day: date('day').notNull(),
    /** Cumulative count at the last snapshot of the day (or period total for statements). */
    total: bigint('total', { mode: 'number' }).notNull(),
    /** Change versus the previous day with data. */
    delta: bigint('delta', { mode: 'number' }).notNull().default(0),
  },
  (t) => [primaryKey({ columns: [t.orgId, t.trackId, t.platform, t.source, t.day] }), index('stream_daily_day_idx').on(t.orgId, t.day)],
);

export const ALERT_KINDS = ['spike', 'drop', 'milestone'] as const;
export type AlertKind = (typeof ALERT_KINDS)[number];

export const alertRules = pgTable(
  'stream_alert_rules',
  {
    ...tenantColumns(),
    name: text('name').notNull(),
    kind: text('kind').$type<AlertKind>().notNull(),
    /** spike/drop: % change of the daily delta vs the trailing average; milestone: absolute total. */
    threshold: numeric('threshold', { precision: 14, scale: 2 }).notNull(),
    windowDays: integer('window_days').notNull().default(7),
    platform: text('platform'),
    /** Ignore tracks below this many daily plays (avoids noise on tiny numbers). */
    minDaily: integer('min_daily').notNull().default(100),
    enabled: boolean('enabled').notNull().default(true),
  },
  (t) => [index('stream_alert_rules_org_idx').on(t.orgId)],
);

export const alerts = pgTable(
  'stream_alerts',
  {
    ...tenantColumns(),
    ruleId: uuid('rule_id').references(() => alertRules.id, { onDelete: 'set null' }),
    trackId: uuid('track_id')
      .notNull()
      .references(() => tracks.id, { onDelete: 'cascade' }),
    kind: text('kind').$type<AlertKind>().notNull(),
    platform: text('platform').notNull(),
    day: date('day').notNull(),
    value: bigint('value', { mode: 'number' }).notNull(),
    baseline: bigint('baseline', { mode: 'number' }),
    message: text('message').notNull(),
    acknowledgedAt: ts('acknowledged_at'),
    acknowledgedBy: text('acknowledged_by'),
  },
  (t) => [uniqueIndex('stream_alerts_dedupe_idx').on(t.orgId, t.trackId, t.kind, t.platform, t.day), index('stream_alerts_org_idx').on(t.orgId, t.createdAt)],
);

export type StreamTrack = typeof streamTracks.$inferSelect;
export type StreamAlert = typeof alerts.$inferSelect;
export type AlertRule = typeof alertRules.$inferSelect;
