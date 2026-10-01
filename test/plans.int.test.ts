import { eq } from 'drizzle-orm';
import { afterAll, afterEach, describe, expect, it } from 'vitest';
import './modules';
import { closeDb, systemDb } from '@labelconsole/core/db/client';
import { organizations } from '@labelconsole/core/db/schema';
import { PLAN_LIMITS, PlanLimitError } from '@labelconsole/core/plans';
import { closeQueues } from '@labelconsole/core/queue';
import { closeRedis } from '@labelconsole/core/redis';
import { createTrack } from '@labelconsole/catalogue/service';
import { files } from '@labelconsole/drive/schema';
import { storeFile } from '@labelconsole/drive/service';
import { inviteMember, planUsage } from '@labelconsole/settings/service';
import { activeTrackCount, backfillRegistry, registerTrack, setTrackStatus } from '@labelconsole/streams/service';
import { makeOrg } from './helpers';

const original = structuredClone(PLAN_LIMITS);
afterEach(() => {
  Object.assign(PLAN_LIMITS.starter, original.starter);
  Object.assign(PLAN_LIMITS.growth, original.growth);
});
afterAll(async () => {
  await closeQueues();
  await closeDb();
  await closeRedis();
});

async function starterOrg(name: string) {
  const o = await makeOrg(name);
  await systemDb().update(organizations).set({ plan: 'starter' }).where(eq(organizations.id, o.org.id));
  return o;
}

describe('plan limits', () => {
  it('counts open invitations as seats', async () => {
    const o = await starterOrg('Seat Label');
    PLAN_LIMITS.starter.seats = 3;
    await o.as((ctx) => inviteMember(ctx, { email: 'one@example.test', role: 'marketing' }));
    await o.as((ctx) => inviteMember(ctx, { email: 'two@example.test', role: 'marketing' }));
    const err = await o.as((ctx) => inviteMember(ctx, { email: 'three@example.test', role: 'marketing' })).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(PlanLimitError);
    expect((err as PlanLimitError).status).toBe(402);
    expect((err as PlanLimitError).message).toMatch(/Starter plan includes 3 of team members/);
  });

  it('holds new tracks back at the tracking limit and adds them once there is room', async () => {
    const o = await makeOrg('Track Label'); // Growth: Streams isn't in Starter
    PLAN_LIMITS.growth.trackedTracks = 2;
    const ids = await o.as(async (ctx) => [await createTrack(ctx, { title: 'One' }), await createTrack(ctx, { title: 'Two' }), await createTrack(ctx, { title: 'Three' })].map((t) => t.id));
    // Separate transactions, as the listeners would run them.
    const registered = [];
    for (const id of ids) registered.push(await o.as((ctx) => registerTrack(ctx, id)));
    expect(registered.filter(Boolean)).toHaveLength(2);
    expect(await o.as(activeTrackCount)).toBe(2);
    // Concurrent registrations can't both take the last slot.
    PLAN_LIMITS.growth.trackedTracks = 3;
    const more = await o.as(async (ctx) => [await createTrack(ctx, { title: 'Four' }), await createTrack(ctx, { title: 'Five' })].map((t) => t.id));
    const raced = await Promise.all(more.map((id) => o.as((ctx) => registerTrack(ctx, id))));
    expect(raced.filter(Boolean)).toHaveLength(1);
    expect(await o.as(activeTrackCount)).toBe(3);
    PLAN_LIMITS.growth.trackedTracks = 2;
    await o.as((ctx) => setTrackStatus(ctx, raced.find(Boolean)!.trackId, 'paused'));
    // The scheduler's backfill does nothing while full...
    expect(await o.as((ctx) => backfillRegistry(ctx))).toBe(0);
    // ...and adds the waiting track once one is paused.
    await o.as((ctx) => setTrackStatus(ctx, ids[0], 'paused'));
    expect(await o.as((ctx) => backfillRegistry(ctx))).toBe(1);
    expect(await o.as(activeTrackCount)).toBe(2);
    // Resuming the paused one would go over.
    await expect(o.as((ctx) => setTrackStatus(ctx, ids[0], 'tracking'))).rejects.toBeInstanceOf(PlanLimitError);
    const usage = await o.as(planUsage);
    expect(usage.used.trackedTracks).toBe(2);
    expect(usage.limits.trackedTracks).toBe(2);
  });

  it('refuses uploads past the storage limit and keeps nothing of the refused file', async () => {
    const o = await starterOrg('Storage Label');
    PLAN_LIMITS.starter.storageBytes = 10;
    await o.as((ctx) => storeFile(ctx, { name: 'a.txt', mime: 'text/plain', body: Buffer.from('12345') }));
    await expect(o.as((ctx) => storeFile(ctx, { name: 'b.txt', mime: 'text/plain', body: Buffer.from('12345678') }))).rejects.toBeInstanceOf(PlanLimitError);
    const rows = await o.as((ctx) => ctx.tx.select({ name: files.name }).from(files));
    expect(rows.map((r) => r.name)).toEqual(['a.txt']);
    expect((await o.as(planUsage)).used.storageBytes).toBe(5);
  });
});
