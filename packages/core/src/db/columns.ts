import { sql } from 'drizzle-orm';
import { text, timestamp, uuid } from 'drizzle-orm/pg-core';

/**
 * Columns every tenant table carries. `org_id` and `created_by` default from the
 * per-transaction settings that `withOrg` sets, so a service cannot forget them,
 * and the RLS policy's WITH CHECK rejects any attempt to write another org's id.
 *
 * Call it per table (it returns fresh column builders each time).
 */
export function tenantColumns() {
  return {
    id: uuid('id').primaryKey().defaultRandom(),
    orgId: uuid('org_id')
      .notNull()
      .default(sql`nullif(current_setting('app.org_id', true), '')::uuid`),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true })
      .notNull()
      .defaultNow()
      .$onUpdate(() => new Date()),
    /** `user:<uuid>`, `agent:<uuid>` or `system`. */
    createdBy: text('created_by').default(sql`nullif(current_setting('app.actor', true), '')`),
  };
}

/** For join/link tables that still need tenant isolation but no audit columns. */
export function orgIdColumn() {
  return uuid('org_id')
    .notNull()
    .default(sql`nullif(current_setting('app.org_id', true), '')::uuid`);
}

export const ts = (name: string) => timestamp(name, { withTimezone: true });
