import { bigint, pgTable, primaryKey, text, uuid } from 'drizzle-orm/pg-core';
import { orgIdColumn, ts } from '@labelconsole/core/db/columns';
import type { StreamSource } from './index';

/**
 * Append-only snapshots. The physical table is partitioned by month (created by
 * a hand-written migration, see migrations/custom); this definition is for
 * typed queries only and is kept out of `schema/index.ts` so drizzle-kit does not generate it.
 */
export const streamSnapshots = pgTable(
  'stream_snapshots',
  {
    id: uuid('id').notNull().defaultRandom(),
    orgId: orgIdColumn(),
    trackId: uuid('track_id').notNull(),
    platform: text('platform').notNull(),
    source: text('source').$type<StreamSource>().notNull(),
    externalId: text('external_id'),
    capturedAt: ts('captured_at').notNull(),
    count: bigint('count', { mode: 'number' }).notNull(),
    createdAt: ts('created_at').notNull().defaultNow(),
  },
  (t) => [primaryKey({ columns: [t.id, t.capturedAt] })],
);

