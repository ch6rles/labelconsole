import { bigint, index, pgTable, text } from 'drizzle-orm/pg-core';
import { tenantColumns, ts } from '@labelconsole/core/db/columns';

/** GDPR-style export of everything a label owns. */
export const dataExports = pgTable(
  'data_exports',
  {
    ...tenantColumns(),
    /** queued | running | done | failed */
    status: text('status').notNull().default('queued'),
    storageKey: text('storage_key'),
    size: bigint('size', { mode: 'number' }),
    tables: text('tables').array(),
    error: text('error'),
    completedAt: ts('completed_at'),
  },
  (t) => [index('data_exports_org_idx').on(t.orgId, t.createdAt)],
);
