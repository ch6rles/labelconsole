import './types';
import { and, ilike, isNull } from 'drizzle-orm';
import { defineModule } from '@labelconsole/core/modules';
import { tools } from './agent-tools';
import { routes } from './api';
import { jobs } from './jobs';
import { KIND_ICON, fileKind } from './kinds';
import { manifest } from './manifest';
import { files } from './schema';
import { storageUsed } from './service';

export default defineModule({
  manifest,
  routes,
  planUsage: async (ctx) => ({ storageBytes: await storageUsed(ctx) }),
  jobs,
  tools,
  schedules: [{ id: 'drive-sync-all', job: 'drive.sync-all', everyMs: 30 * 60_000 }],
  search: async (ctx, q) => {
    if (!ctx.can('drive:read')) return [];
    const rows = await ctx.tx.select({ id: files.id, name: files.name, folderId: files.folderId, confidential: files.confidential }).from(files).where(and(ilike(files.name, `%${q}%`), isNull(files.deletedAt))).limit(6);
    return rows.filter((r) => !r.confidential || ctx.can('documents:read_confidential')).map((r) => ({ type: 'File', title: r.name, sub: 'Drive file', href: `/drive/files/${r.id}`, icon: KIND_ICON[fileKind(r.name, null)] }));
  },
});
