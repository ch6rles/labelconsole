import { bigint, boolean, index, pgTable, text, uniqueIndex, uuid, type AnyPgColumn } from 'drizzle-orm/pg-core';
import { orgIdColumn, tenantColumns, ts } from '@labelconsole/core/db/columns';

export const folders = pgTable(
  'drive_folders',
  {
    ...tenantColumns(),
    parentId: uuid('parent_id').references((): AnyPgColumn => folders.id, { onDelete: 'cascade' }),
    name: text('name').notNull(),
    /** Materialised path of ids, e.g. `/rootId/childId/`, for subtree queries. */
    path: text('path').notNull().default('/'),
    externalProvider: text('external_provider'),
    externalId: text('external_id'),
    /** none | mirror (pull only) | sync (two-way). */
    syncMode: text('sync_mode').notNull().default('none'),
    lastSyncedAt: ts('last_synced_at'),
    syncError: text('sync_error'),
  },
  (t) => [index('drive_folders_parent_idx').on(t.orgId, t.parentId)],
);

export const files = pgTable(
  'drive_files',
  {
    ...tenantColumns(),
    folderId: uuid('folder_id').references(() => folders.id, { onDelete: 'set null' }),
    name: text('name').notNull(),
    storageKey: text('storage_key').notNull(),
    size: bigint('size', { mode: 'number' }).notNull().default(0),
    mime: text('mime').notNull().default('application/octet-stream'),
    checksum: text('checksum'),
    /** ready | quarantined | deleted */
    status: text('status').notNull().default('ready'),
    /** pending | clean | infected | skipped */
    scanStatus: text('scan_status').notNull().default('pending'),
    externalProvider: text('external_provider'),
    externalId: text('external_id'),
    confidential: boolean('confidential').notNull().default(false),
    deletedAt: ts('deleted_at'),
  },
  (t) => [
    index('drive_files_folder_idx').on(t.orgId, t.folderId),
    uniqueIndex('drive_files_external_idx').on(t.orgId, t.externalProvider, t.externalId),
  ],
);

/** Per-folder grants. No rows = inherit the module permission. */
export const folderPermissions = pgTable(
  'drive_folder_permissions',
  {
    ...tenantColumns(),
    folderId: uuid('folder_id')
      .notNull()
      .references(() => folders.id, { onDelete: 'cascade' }),
    /** role | user */
    principalType: text('principal_type').notNull(),
    principal: text('principal').notNull(),
    /** view | edit | manage */
    access: text('access').notNull(),
  },
  (t) => [uniqueIndex('drive_folder_perm_idx').on(t.folderId, t.principalType, t.principal)],
);

/** A file attached to any record in any module (artist, release, campaign...). */
export const fileLinks = pgTable(
  'drive_file_links',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    orgId: orgIdColumn(),
    fileId: uuid('file_id')
      .notNull()
      .references(() => files.id, { onDelete: 'cascade' }),
    entityType: text('entity_type').notNull(),
    entityId: uuid('entity_id').notNull(),
    createdAt: ts('created_at').notNull().defaultNow(),
  },
  (t) => [uniqueIndex('drive_file_links_uniq').on(t.fileId, t.entityType, t.entityId), index('drive_file_links_entity_idx').on(t.orgId, t.entityType, t.entityId)],
);

export type DriveFile = typeof files.$inferSelect;
export type DriveFolder = typeof folders.$inferSelect;
