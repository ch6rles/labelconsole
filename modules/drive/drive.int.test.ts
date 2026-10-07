import { and, eq } from 'drizzle-orm';
import { afterAll, describe, expect, it } from 'vitest';
import '../../test/modules';
import { closeDb } from '@labelconsole/core/db/client';
import { auditLog } from '@labelconsole/core/db/schema';
import { ForbiddenError, NotFoundError, ValidationError } from '@labelconsole/core/errors';
import { closeQueues } from '@labelconsole/core/queue';
import { closeRedis } from '@labelconsole/core/redis';
import { addMember, makeOrg } from '../../test/helpers';
import { routes } from './api';
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

  it('accepts the everyday formats browsers send without a type, and stores code as plain text', async () => {
    const a = await makeOrg('Formats Label');
    const store = (name: string, body: Buffer | string, mime = 'application/octet-stream') => a.as((ctx) => svc.storeFile(ctx, { name, mime, body: Buffer.from(body) }));
    expect((await store('brief.md', '# Brief')).mime).toBe('text/markdown');
    expect((await store('font.ttf', Buffer.from([0, 1, 0, 0, 0, 1]))).mime).toBe('font/ttf');
    expect((await store('deck.pptx', Buffer.from('PK\x03\x04 deck'))).mime).toBe('application/vnd.openxmlformats-officedocument.presentationml.presentation');
    // Chrome labels .ts files as MPEG transport streams.
    expect((await store('sync.ts', 'export const x = 1;', 'video/mp2t')).mime).toBe('text/plain');
    await expect(store('setup.exe', Buffer.from('MZ'))).rejects.toBeInstanceOf(ValidationError);
  });

  it('previews files browsers cannot open, and refuses quarantined ones', async () => {
    const a = await makeOrg('Preview Label');
    // An agent's Markdown report saved as text/plain still previews as text (the viewer renders it by its extension).
    const md = await a.as((ctx) => svc.storeFile(ctx, { name: 'Release brief.md', mime: 'text/plain', body: Buffer.from('# Ainsi Bas La Vida\n\nPitch on 9 October.') }));
    expect(await a.as((ctx) => svc.previewFile(ctx, md.id))).toMatchObject({ kind: 'text', truncated: false, encoding: 'UTF-8', text: expect.stringContaining('# Ainsi Bas La Vida') });
    const csv = await a.as((ctx) => svc.storeFile(ctx, { name: 'royalties.csv', mime: 'text/csv', body: Buffer.from('Store,Plays\nSpotify,1520\n') }));
    expect(await a.as((ctx) => svc.previewFile(ctx, csv.id))).toMatchObject({ kind: 'sheet', sheets: [{ name: 'royalties', totalRows: 2, rows: [['Store', 'Plays'], ['Spotify', '1520']] }] });
    const old = await a.as((ctx) => svc.storeFile(ctx, { name: 'contract.doc', mime: 'application/msword', body: Buffer.from([0xd0, 0xcf, 0x11, 0xe0]) }));
    expect(await a.as((ctx) => svc.previewFile(ctx, old.id))).toMatchObject({ kind: 'unsupported', reason: expect.stringContaining('.docx') });
    const broken = await a.as((ctx) => svc.storeFile(ctx, { name: 'broken.xlsx', mime: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', body: Buffer.from('PK\x03\x04 not really') }));
    expect(await a.as((ctx) => svc.previewFile(ctx, broken.id))).toMatchObject({ kind: 'unsupported', reason: expect.stringContaining('couldn’t be read') });

    await a.as((ctx) => ctx.tx.update(files).set({ status: 'quarantined' }).where(eq(files.id, md.id)));
    await expect(a.as((ctx) => svc.previewFile(ctx, md.id))).rejects.toBeInstanceOf(ForbiddenError);
    await expect(a.as((ctx) => svc.fileContent(ctx, md.id))).rejects.toBeInstanceOf(ForbiddenError);
  });

  it('serves a file’s bytes from the app, in ranges, as an inert sandboxed document', async () => {
    const a = await makeOrg('Content Label');
    const page = await a.as((ctx) => svc.storeFile(ctx, { name: 'page.html', mime: 'text/html', body: Buffer.from('<script>alert(1)</script><p>hello</p>') }));
    const content = routes.find((r) => r.path === '/drive/files/:id/content')!;
    const get = (id: string, headers: Record<string, string> = {}, query: Record<string, string> = {}) =>
      a.as(async (ctx) => {
        const res = (await content.handler(ctx, { params: { id }, query, body: undefined, form: undefined, request: new Request('http://test/x', { headers }), session: undefined } as never)) as Response;
        return { status: res.status, headers: Object.fromEntries(res.headers), body: res.body ? Buffer.from(await res.arrayBuffer()).toString() : '' };
      });

    const whole = await get(page.id);
    expect(whole.status).toBe(200);
    expect(whole.body).toBe('<script>alert(1)</script><p>hello</p>');
    // HTML is served as text, in a sandbox, never sniffed: opening the link can't run anything.
    expect(whole.headers['content-type']).toBe('text/plain; charset=utf-8');
    expect(whole.headers['content-security-policy']).toMatch(/^sandbox;/);
    expect(whole.headers['x-content-type-options']).toBe('nosniff');
    expect(whole.headers['accept-ranges']).toBe('bytes');
    expect(whole.headers['content-disposition']).toBe("inline; filename*=UTF-8''page.html");

    const part = await get(page.id, { range: 'bytes=25-29' });
    expect(part.status).toBe(206);
    expect(part.body).toBe('<p>he');
    expect(part.headers['content-range']).toBe('bytes 25-29/37');
    expect(part.headers['content-length']).toBe('5');
    expect((await get(page.id, { range: 'bytes=-6' })).body).toBe('lo</p>');
    expect((await get(page.id, { range: 'bytes=500-' })).status).toBe(416);
    expect((await get(page.id, {}, { download: '1' })).headers['content-disposition']).toMatch(/^attachment;/);

    expect(svc.parseRange('bytes=0-', 10)).toEqual({ start: 0, end: 9 });
    expect(svc.parseRange('bytes=5-100', 10)).toEqual({ start: 5, end: 9 });
    expect(svc.parseRange('items=0-1', 10)).toBeNull();
    expect(svc.parseRange('bytes=-', 10)).toBe(false);
  });

  it('logs opening a confidential file once, not for every range the viewer asks for', async () => {
    const a = await makeOrg('Audit Label');
    const f = await a.as((ctx) => svc.storeFile(ctx, text('deal-memo.txt', null, true)));
    await a.as((ctx) => svc.fileContent(ctx, f.id));
    await a.as((ctx) => svc.fileContent(ctx, f.id, 'bytes=5-9'));
    const viewed = await a.as((ctx) => ctx.tx.select().from(auditLog).where(and(eq(auditLog.action, 'file.viewed'), eq(auditLog.targetId, f.id))));
    expect(viewed).toHaveLength(1);
  });

  it('steps through a folder in the order it lists files, skipping what the reader can’t see', async () => {
    const a = await makeOrg('Siblings Label');
    const marketing = await addMember(a, 'marketing');
    const folder = await a.as((ctx) => svc.createFolder(ctx, { name: 'Promo' }));
    const first = await a.as((ctx) => svc.storeFile(ctx, text('one.txt', folder.id)));
    await a.as((ctx) => svc.storeFile(ctx, text('secret.txt', folder.id, true)));
    const third = await a.as((ctx) => svc.storeFile(ctx, text('three.txt', folder.id)));
    // Newest first, like the folder.
    const owner = await a.as((ctx) => svc.siblings(ctx, third.id));
    expect(owner).toMatchObject({ previous: null, next: { name: 'secret.txt' }, position: 1, count: 3 });
    const mk = await marketing.as((ctx) => svc.siblings(ctx, third.id));
    expect(mk).toMatchObject({ previous: null, next: { id: first.id }, position: 1, count: 2 });

    // Files can be moved to any folder the reader can edit; links to records are listed.
    const options = await a.as((ctx) => svc.folderOptions(ctx));
    expect(options.map((o) => o.label)).toContain('Promo');
    expect(await a.as((ctx) => svc.linksOf(ctx, first.id))).toEqual([]);
  });
});
