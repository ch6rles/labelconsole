import { PassThrough } from 'node:stream';
import { eq, sql } from 'drizzle-orm';
import '../types';
import { systemDb } from '@labelconsole/core/db/client';
import { invitations, organizations, sessions } from '@labelconsole/core/db/schema';
import { sendMail } from '@labelconsole/core/mail';
import { defineJob } from '@labelconsole/core/queue';
import { publish } from '@labelconsole/core/realtime';
import { storage, storageKey } from '@labelconsole/core/storage';
import { getCredentialHandle } from '@labelconsole/core/vault';
import { dataExports } from '../schema';

/** Every tenant table, discovered from the catalogue so new modules are exported automatically. */
async function tenantTables(): Promise<string[]> {
  const rows = (await systemDb().execute(sql`
    select c.relname as name from pg_class c
    join pg_namespace n on n.oid = c.relnamespace
    join pg_attribute a on a.attrelid = c.oid and a.attname = 'org_id' and not a.attisdropped
    where n.nspname = 'public' and c.relkind in ('r', 'p') and not c.relispartition
    order by c.relname`)) as unknown as Array<{ name: string }>;
  return rows.map((r) => r.name);
}

export const jobs = [
  defineJob('settings.send-invite', async (job, data) => {
    await job.withOrg(async (ctx) => {
      if (!(await getCredentialHandle(ctx, 'smtp'))) {
        job.log.info('no SMTP credential; invitation link is shown to the inviter instead');
        return;
      }
      const [inv] = await ctx.tx.select().from(invitations).where(eq(invitations.id, data.invitationId));
      const [org] = await ctx.tx.select({ name: organizations.name }).from(organizations).where(eq(organizations.id, ctx.orgId));
      if (!inv || inv.acceptedAt || inv.revokedAt) return;
      await sendMail(ctx, {
        to: inv.email,
        subject: `You're invited to ${org.name} on Label Console`,
        text: `You've been invited to join ${org.name} on Label Console.\n\nAccept the invitation: ${data.url}\n\nThe link expires on ${inv.expiresAt.toDateString()}.`,
      });
    });
  }),

  defineJob('settings.export', async (job, data) => {
    const orgId = job.orgId!;
    await job.withOrg((ctx) => ctx.tx.update(dataExports).set({ status: 'running' }).where(eq(dataExports.id, data.exportId)));
    try {
      const tables = await tenantTables();
      const key = storageKey(orgId, 'exports', `label-export-${new Date().toISOString().slice(0, 10)}.ndjson`);
      const out = new PassThrough();
      const upload = storage().put(key, out, { contentType: 'application/x-ndjson' });
      out.write(JSON.stringify({ type: 'header', exportedAt: new Date().toISOString(), orgId, tables, format: 'one JSON object per line: {"table": ..., "row": {...}}' }) + '\n');
      for (const [i, table] of tables.entries()) {
        // Read through the restricted role with the org context set: RLS guarantees only this label's rows.
        let offset = 0;
        for (;;) {
          const rows = await job.withOrg((ctx) => ctx.tx.execute(sql`select * from ${sql.identifier(table)} order by 1 limit 2000 offset ${offset}`));
          const list = rows as unknown as Array<Record<string, unknown>>;
          for (const row of list) {
            if (table === 'credentials') for (const k of ['ciphertext', 'iv', 'auth_tag']) delete row[k];
            if (table === 'org_keys') delete row.wrapped_key;
            out.write(JSON.stringify({ table, row }) + '\n');
          }
          if (list.length < 2000) break;
          offset += 2000;
        }
        await job.progress(Math.round(((i + 1) / tables.length) * 100));
      }
      out.end();
      const { size } = await upload;
      await job.withOrg(async (ctx) => {
        const [row] = await ctx.tx.update(dataExports).set({ status: 'done', storageKey: key, size, tables, completedAt: new Date() }).where(eq(dataExports.id, data.exportId)).returning();
        await ctx.emit('settings.export.ready', { exportId: data.exportId, requestedBy: row.createdBy });
      });
      await publish(orgId, { type: 'settings.export.updated', data: { exportId: data.exportId, status: 'done' }, permission: 'settings:export' });
    } catch (err) {
      await job.withOrg((ctx) => ctx.tx.update(dataExports).set({ status: 'failed', error: (err as Error).message }).where(eq(dataExports.id, data.exportId)));
      throw err;
    }
  }),

  defineJob('settings.delete-org', async (job) => {
    const orgId = job.orgId!;
    const db = systemDb();
    const tables = await tenantTables();
    // Delete children before parents: retry tables blocked by foreign keys until all are empty.
    let remaining = [...tables];
    for (let pass = 0; pass < 10 && remaining.length; pass++) {
      const next: string[] = [];
      for (const t of remaining) {
        try {
          await db.execute(sql`delete from ${sql.identifier(t)} where org_id = ${orgId}`);
        } catch {
          next.push(t);
        }
      }
      remaining = next;
    }
    if (remaining.length) throw new Error(`Could not delete rows from: ${remaining.join(', ')}`);
    await storage().deletePrefix(`${orgId}/`);
    await db.update(sessions).set({ activeOrgId: null }).where(eq(sessions.activeOrgId, orgId));
    await db.delete(organizations).where(eq(organizations.id, orgId));
    job.log.info({ orgId }, 'label deleted');
  }),
];
