import { afterAll, describe, expect, it } from 'vitest';
import '../../test/modules';
import { closeDb } from '@labelconsole/core/db/client';
import { ConflictError } from '@labelconsole/core/errors';
import { closeQueues } from '@labelconsole/core/queue';
import { closeRedis } from '@labelconsole/core/redis';
import { makeOrg } from '../../test/helpers';
import * as svc from './service';

afterAll(async () => {
  await closeQueues();
  await closeDb();
  await closeRedis();
});

describe('network', () => {
  it('normalises handles and refuses duplicates by handle or email, within a label only', async () => {
    expect(svc.normalizeHandle('https://www.tiktok.com/@OlaHart?lang=en')).toBe('olahart');
    expect(svc.normalizeHandle('@OlaHart')).toBe('olahart');

    const a = await makeOrg('Network Label');
    await a.as((ctx) => svc.createContact(ctx, { name: 'Ola Hart', email: 'Ola@Example.test', handles: { tiktok: '@OlaHart' } }));
    await expect(a.as((ctx) => svc.createContact(ctx, { name: 'Ola H.', handles: { tiktok: 'https://tiktok.com/@olahart' } }))).rejects.toBeInstanceOf(ConflictError);
    await expect(a.as((ctx) => svc.createContact(ctx, { name: 'Ola again', email: 'ola@example.TEST' }))).rejects.toBeInstanceOf(ConflictError);
    // Another label can have its own record of the same creator.
    const b = await makeOrg('Other Network Label');
    await b.as((ctx) => svc.createContact(ctx, { name: 'Ola Hart', handles: { tiktok: 'olahart' } }));
  });

  it('moves relationship stages with interactions and respects do-not-contact', async () => {
    const a = await makeOrg('Stage Label');
    const c = await a.as((ctx) => svc.createContact(ctx, { name: 'Indie Finds', type: 'editor', email: 'ed@indiefinds.test' }));
    expect(c.stage).toBe('lead');
    await a.as((ctx) => svc.logInteraction(ctx, c.id, { channel: 'note', summary: 'Heard they like dream pop' }));
    expect((await a.as((ctx) => svc.getContactRow(ctx, c.id))).stage).toBe('lead');
    await a.as((ctx) => svc.logInteraction(ctx, c.id, { channel: 'email', summary: 'Sent Night Ferries' }));
    expect((await a.as((ctx) => svc.getContactRow(ctx, c.id))).stage).toBe('contacted');
    await a.as((ctx) => svc.logInteraction(ctx, c.id, { channel: 'email', direction: 'inbound', summary: 'Loved it' }));
    const engaged = await a.as((ctx) => svc.getContactRow(ctx, c.id));
    expect(engaged.stage).toBe('engaged');
    expect(engaged.lastContactedAt).not.toBeNull();

    // A partial update leaves the stage alone; do-not-contact blocks outreach but not notes.
    await a.as((ctx) => svc.updateContact(ctx, c.id, { organization: 'Indie Finds Ltd' }));
    expect((await a.as((ctx) => svc.getContactRow(ctx, c.id))).stage).toBe('engaged');
    await a.as((ctx) => svc.updateContact(ctx, c.id, { stage: 'do_not_contact' }));
    await expect(a.as((ctx) => svc.logInteraction(ctx, c.id, { channel: 'email', summary: 'One more try' }))).rejects.toBeInstanceOf(ConflictError);
    await a.as((ctx) => svc.logInteraction(ctx, c.id, { channel: 'note', summary: 'Asked us to stop' }));
  });

  it('gives agents contact details without payout addresses, and counts accounts', async () => {
    const a = await makeOrg('Agent View Label');
    const c = await a.as((ctx) => svc.createContact(ctx, { name: 'Mika Sun', handles: { tiktok: 'mikasun' }, payoutEmail: 'mika@pay.test', rateCents: 90000 }));
    expect(JSON.stringify(svc.contactForAgent(c))).not.toContain('mika@pay.test');
    await a.as((ctx) => svc.setAccountState(ctx, c.id, 'gone'));
    const counts = await a.as(svc.networkCounts);
    expect(counts.gone).toBe(1);
    expect(counts.unverifiedCreators).toBe(0);
  });
});
