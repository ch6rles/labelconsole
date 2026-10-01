import { index, pgTable, text, uuid } from 'drizzle-orm/pg-core';
import { tenantColumns, ts } from '@labelconsole/core/db/columns';

export const NOTIFICATION_KINDS = ['approval', 'mention', 'alert', 'reminder', 'agent', 'system', 'assignment'] as const;
export type NotificationKind = (typeof NOTIFICATION_KINDS)[number];

export const notifications = pgTable(
  'notifications',
  {
    ...tenantColumns(),
    /** Recipient. */
    userId: uuid('user_id').notNull(),
    kind: text('kind').$type<NotificationKind>().notNull(),
    title: text('title').notNull(),
    body: text('body'),
    href: text('href'),
    entityType: text('entity_type'),
    entityId: text('entity_id'),
    /** Who caused it (user:<id>, agent:<id>, system). */
    actor: text('actor'),
    actorLabel: text('actor_label'),
    readAt: ts('read_at'),
    /** Dedupe key so retried event delivery never doubles a notification. */
    dedupeKey: text('dedupe_key'),
  },
  (t) => [index('notifications_user_idx').on(t.orgId, t.userId, t.readAt, t.createdAt), index('notifications_dedupe_idx').on(t.orgId, t.dedupeKey)],
);

export type Notification = typeof notifications.$inferSelect;
