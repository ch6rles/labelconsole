import { afterAll, describe, expect, it } from 'vitest';
import '../../test/modules';
import { closeDb } from '@labelconsole/core/db/client';
import { closeQueues } from '@labelconsole/core/queue';
import { closeRedis } from '@labelconsole/core/redis';
import { createRelease } from '@labelconsole/catalogue/service';
import { uploadDocument } from '@labelconsole/documents/service';
import { addMember, makeOrg } from '../../test/helpers';
import * as svc from './service';

afterAll(async () => {
  await closeQueues();
  await closeDb();
  await closeRedis();
});

describe('inbox', () => {
  it('notifies everyone holding a permission, once per dedupe key', async () => {
    const a = await makeOrg('Inbox Label');
    const finance = await addMember(a, 'finance');
    const marketing = await addMember(a, 'marketing');
    const send = () => a.as((ctx) => svc.notify(ctx, { permission: 'documents:read_financial', kind: 'system', title: 'Statement parsed', dedupeKey: 'statement-1' }));
    const first = await send();
    expect(first.map((n) => n.userId).sort()).toEqual([a.user.id, finance.user.id].sort());
    expect(await send()).toEqual([]);
    expect(await marketing.as((ctx) => svc.unreadCount(ctx, marketing.user.id))).toBe(0);

    expect(await finance.as((ctx) => svc.unreadCount(ctx, finance.user.id))).toBe(1);
    await finance.as((ctx) => svc.markRead(ctx, finance.user.id));
    expect(await finance.as((ctx) => svc.unreadCount(ctx, finance.user.id))).toBe(0);
    // Marking read is per person.
    expect(await a.as((ctx) => svc.unreadCount(ctx, a.user.id))).toBe(1);
  });

  it('shows activity only from modules the reader can see', async () => {
    const a = await makeOrg('Activity Label');
    await a.as((ctx) => createRelease(ctx, { title: 'Visible Single' }));
    await a.as((ctx) => ctx.audit({ action: 'test.settings_change', module: 'settings', targetType: 'organization', targetId: a.org.id }));
    const marketing = await addMember(a, 'marketing');
    const seen = await marketing.as((ctx) => svc.activity(ctx, {}));
    expect(seen.some((e) => e.module === 'catalogue')).toBe(true);
    expect(seen.some((e) => e.module === 'settings')).toBe(false);
    const owner = await a.as((ctx) => svc.activity(ctx, {}));
    expect(owner.some((e) => e.module === 'settings')).toBe(true);
  });

  it('keeps confidential documents and statements out of the feed for people who can’t open them', async () => {
    const a = await makeOrg('Sensitive Label');
    const doc = (name: string, meta: Parameters<typeof uploadDocument>[2]) => a.as((ctx) => uploadDocument(ctx, { name, mime: 'text/plain', body: Buffer.from(`text of ${name}`) }, meta));
    await doc('press.txt', { type: 'other', title: 'Press release draft' });
    await doc('deal.txt', { type: 'contract', title: 'Secret deal memo', confidential: true });
    await doc('dk.csv', { type: 'statement', title: 'DistroKid statement' });
    const titles = async (who: { as: typeof a.as }) => (await who.as((ctx) => svc.activity(ctx, {}))).filter((e) => e.module === 'documents').map((e) => e.targetLabel).sort();

    const marketing = await addMember(a, 'marketing'); // documents:read only
    expect(await titles(marketing)).toEqual(['Press release draft']);
    const finance = await addMember(a, 'finance'); // financial and confidential
    expect(await titles(finance)).toEqual(['DistroKid statement', 'Press release draft', 'Secret deal memo']);
  });
});
