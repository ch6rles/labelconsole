import { eq } from 'drizzle-orm';
import { afterAll, describe, expect, it } from 'vitest';
import '../../test/modules';
import { closeDb } from '@labelconsole/core/db/client';
import { ForbiddenError, NotFoundError, ValidationError } from '@labelconsole/core/errors';
import { closeQueues } from '@labelconsole/core/queue';
import { closeRedis } from '@labelconsole/core/redis';
import { addMember, makeOrg } from '../../test/helpers';
import { files, folders } from './schema';
import * as svc from './service';

afterAll(async () => {
  await closeQueues();
  await closeDb();
  await closeRedis();
});

const text = (name: string, folderId?: string | null, confidential = false) => ({ name, mime: 'text/plain', body: Buffer.from(`contents of ${name}`), folderId, confidential });

describe('drive', () => {
  it('lets folder grants narrow access: the deepest folder with grants decides', async () => {
    const a = await makeOrg('Drive Label');
    const marketing = await addMember(a, 'marketing');
    const finance = await addMember(a, 'finance');

    const money = await a.as((ctx) => svc.createFolder(ctx, { name: 'Finance' }));
    const shared = await a.as((ctx) => svc.createFolder(ctx, { name: 'Shared with marketing', parentId: money.id }));
    await a.as((ctx) => svc.setGrant(ctx, money.id, { principalType: 'role', principal: 'finance', access: 'edit' }));
    await a.as((ctx) => svc.setGrant(ctx, shared.id, { principalType: 'role', principal: 'marketing', access: 'edit' }));

    // Marketing can't open Finance, doesn't even see it at the root, and can't upload into it.
    await expect(marketing.as((ctx) => svc.listFolder(ctx, money.id))).rejects.toBeInstanceOf(ForbiddenError);
    expect((await marketing.as((ctx) => svc.listFolder(ctx, null))).folders.map((f) => f.name)).not.toContain('Finance');
    await expect(marketing.as((ctx) => svc.storeFile(ctx, text('leak.txt', money.id)))).rejects.toBeInstanceOf(ForbiddenError);
    // ...but the subfolder granted to marketing is theirs to use.
    expect((await marketing.as((ctx) => svc.listFolder(ctx, shared.id))).access).toBe('edit');
    await marketing.as((ctx) => svc.storeFile(ctx, text('brief.txt', shared.id)));

    // Finance works in Finance; a deeper grant without them shuts them out of the subfolder.
    await finance.as((ctx) => svc.storeFile(ctx, text('q3.txt', money.id)));
    await expect(finance.as((ctx) => svc.listFolder(ctx, shared.id))).rejects.toBeInstanceOf(ForbiddenError);

    // drive:manage (owner) always has full access.
    expect((await a.as((ctx) => svc.listFolder(ctx, shared.id))).access).toBe('manage');
    // Only drive:manage may change grants.
    await expect(marketing.as((ctx) => svc.setGrant(ctx, shared.id, { principalType: 'role', principal: 'viewer', access: 'view' }))).rejects.toBeInstanceOf(ForbiddenError);
  });

  it('hides confidential files from people without confidential access', async () => {
    const a = await makeOrg('Confidential Label');
    const marketing = await addMember(a, 'marketing');
    const finance = await addMember(a, 'finance');
    await a.as((ctx) => svc.storeFile(ctx, text('contract.txt', null, true)));
    await a.as((ctx) => svc.storeFile(ctx, text('press-kit.txt')));
    const names = async (who: typeof marketing) => (await who.as((ctx) => svc.listFolder(ctx, null))).files.map((f) => f.name).sort();
    expect(await names(marketing)).toEqual(['press-kit.txt']);
    expect(await names(finance)).toEqual(['contract.txt', 'press-kit.txt']);
  });

  it('validates names and content, and deletes a folder with everything under it', async () => {
    const a = await makeOrg('Tidy Label');
    await expect(a.as((ctx) => svc.createFolder(ctx, svc.FolderInput.parse({ name: 'a/b' })))).rejects.toThrow();
    // A file claiming to be a PNG must look like one.
    await expect(a.as((ctx) => svc.storeFile(ctx, { name: 'cover.png', mime: 'image/png', body: Buffer.from('not a png at all') }))).rejects.toBeInstanceOf(ValidationError);
    await expect(a.as((ctx) => svc.storeFile(ctx, { name: 'empty.txt', mime: 'text/plain', body: Buffer.alloc(0) }))).rejects.toBeInstanceOf(ValidationError);

    const top = await a.as((ctx) => svc.createFolder(ctx, { name: 'Old campaign' }));
    const sub = await a.as((ctx) => svc.createFolder(ctx, { name: 'Assets', parentId: top.id }));
    const f = await a.as((ctx) => svc.storeFile(ctx, text('notes.txt', sub.id)));
    await a.as((ctx) => svc.deleteFolder(ctx, top.id));
    expect(await a.as((ctx) => ctx.tx.select().from(folders).where(eq(folders.id, sub.id)))).toHaveLength(0);
    const [gone] = await a.as((ctx) => ctx.tx.select().from(files).where(eq(files.id, f.id)));
    expect(gone.deletedAt).not.toBeNull();
  });

  it('never shows one label another label’s files', async () => {
    const a = await makeOrg('Owner Label');
    const b = await makeOrg('Other Label');
    const f = await a.as((ctx) => svc.storeFile(ctx, text('private.txt')));
    await expect(b.as((ctx) => svc.getFile(ctx, f.id))).rejects.toBeInstanceOf(NotFoundError);
    expect((await b.as((ctx) => svc.listFolder(ctx, null))).files).toHaveLength(0);
  });
});
