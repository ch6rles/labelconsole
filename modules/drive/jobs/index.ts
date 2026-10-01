import '../types';
import { and, eq, isNotNull, sql } from 'drizzle-orm';
import { systemDb } from '@labelconsole/core/db/client';
import { enqueue, defineJob } from '@labelconsole/core/queue';
import { scanStream } from '@labelconsole/core/scan';
import { storage } from '@labelconsole/core/storage';
import { readSecret } from '@labelconsole/core/vault';
import { files, folders } from '../schema';
import { accessToken, download, GOOGLE_FOLDER, listChildren, type GoogleSecret } from '../google';
import { storeFile } from '../service';

export const jobs = [
  defineJob('drive.scan-file', async (job, data) => {
    const file = await job.withOrg(async (ctx) => (await ctx.tx.select().from(files).where(eq(files.id, data.fileId)))[0]);
    if (!file || file.deletedAt) return;
    const result = await scanStream(await storage().get(file.storageKey));
    if (result.status === 'error') throw new Error(`Virus scan failed: ${result.error}`);
    await job.withOrg(async (ctx) => {
      await ctx.tx.update(files).set({ scanStatus: result.status, status: result.status === 'infected' ? 'quarantined' : file.status }).where(eq(files.id, file.id));
      if (result.status === 'infected') await ctx.audit({ action: 'file.quarantined', module: 'drive', targetType: 'file', targetId: file.id, targetLabel: file.name, after: { signature: result.signature } });
    });
  }),

  defineJob('drive.sync-folder', async (job, data) => {
    const { folder, secret } = await job.withOrg(async (ctx) => {
      const [folder] = await ctx.tx.select().from(folders).where(eq(folders.id, data.folderId));
      const cred = await readSecret(ctx, 'google_drive');
      return { folder, secret: cred?.secret as GoogleSecret | undefined };
    });
    if (!folder?.externalId) return;
    if (!secret) {
      await job.withOrg((ctx) => ctx.tx.update(folders).set({ syncError: 'Google Drive is not connected. Add it under Settings → Integrations.' }).where(eq(folders.id, folder.id)));
      return;
    }
    try {
      const token = await accessToken(secret);
      let added = 0;
      let updated = 0;
      // Breadth-first walk, mirroring subfolders as local subfolders.
      const queue: Array<{ localId: string; remoteId: string }> = [{ localId: folder.id, remoteId: folder.externalId }];
      while (queue.length) {
        const { localId, remoteId } = queue.shift()!;
        for (const item of await listChildren(token, remoteId)) {
          if (item.mimeType === GOOGLE_FOLDER) {
            const local = await job.withOrg(async (ctx) => {
              const [existing] = await ctx.tx.select().from(folders).where(and(eq(folders.externalProvider, 'google_drive'), eq(folders.externalId, item.id)));
              if (existing) return existing;
              const [parent] = await ctx.tx.select().from(folders).where(eq(folders.id, localId));
              const [row] = await ctx.tx.insert(folders).values({ name: item.name, parentId: localId, path: `${parent.path}${parent.id}/`, externalProvider: 'google_drive', externalId: item.id, syncMode: 'mirror' }).returning();
              return row;
            });
            queue.push({ localId: local.id, remoteId: item.id });
            continue;
          }
          const existing = await job.withOrg(async (ctx) => (await ctx.tx.select().from(files).where(and(eq(files.externalProvider, 'google_drive'), eq(files.externalId, item.id))))[0]);
          const remoteVersion = item.md5Checksum ?? item.modifiedTime;
          if (existing && !existing.deletedAt && existing.checksum === remoteVersion) continue;
          const content = await download(token, item, 200 * 1024 * 1024);
          if (!content) continue;
          await job.withOrg(async (ctx) => {
            if (existing) {
              await ctx.tx.update(files).set({ deletedAt: new Date(), status: 'deleted', externalId: `${item.id}:replaced:${Date.now()}` }).where(eq(files.id, existing.id));
              updated++;
            } else added++;
            const row = await storeFile(ctx, { name: content.name, mime: content.mime, body: content.body, folderId: localId, external: { provider: 'google_drive', id: item.id } });
            // Remember the remote version so unchanged files are skipped next time.
            await ctx.tx.update(files).set({ checksum: remoteVersion }).where(eq(files.id, row.id));
          });
        }
      }
      await job.withOrg(async (ctx) => {
        await ctx.tx.update(folders).set({ lastSyncedAt: new Date(), syncError: null }).where(eq(folders.id, folder.id));
        await ctx.emit('drive.folder.synced', { folderId: folder.id, added, updated });
      });
      job.log.info({ added, updated }, 'google drive folder mirrored');
    } catch (err) {
      await job.withOrg((ctx) => ctx.tx.update(folders).set({ syncError: (err as Error).message.slice(0, 500) }).where(eq(folders.id, folder.id)));
      throw err;
    }
  }),

  defineJob('drive.sync-all', async () => {
    const roots = await systemDb()
      .select({ id: folders.id, orgId: folders.orgId })
      .from(folders)
      .where(
        and(
          eq(folders.externalProvider, 'google_drive'),
          eq(folders.syncMode, 'mirror'),
          isNotNull(folders.externalId),
          // Roots only: no parent, or a parent that isn't itself synced. Outer column qualified by hand so it doesn't bind to the alias p.
          sql`("drive_folders"."parent_id" is null or not exists (select 1 from drive_folders p where p.id = "drive_folders"."parent_id" and p.external_provider = 'google_drive'))`,
        ),
      );
    for (const r of roots) await enqueue('drive.sync-folder', r.orgId, { folderId: r.id }, { jobId: `sync-${r.id}-${new Date().toISOString().slice(0, 13)}` });
  }),
];
