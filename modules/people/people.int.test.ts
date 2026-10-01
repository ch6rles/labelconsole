import { afterAll, describe, expect, it } from 'vitest';
import '../../test/modules';
import { withOrg } from '@labelconsole/core/context';
import { closeDb } from '@labelconsole/core/db/client';
import { ForbiddenError, NotFoundError } from '@labelconsole/core/errors';
import { PermissionSet } from '@labelconsole/core/permissions';
import { closeQueues } from '@labelconsole/core/queue';
import { closeRedis } from '@labelconsole/core/redis';
import { addMember, makeOrg } from '../../test/helpers';
import * as svc from './service';

afterAll(async () => {
  await closeQueues();
  await closeDb();
  await closeRedis();
});

describe('people', () => {
  it('keeps unsent fields on update and records onboarding start', async () => {
    const a = await makeOrg('Roster Label');
    const artist = await a.as((ctx) => svc.createArtist(ctx, { name: 'Mara Ellis', status: 'prospect', payoutMethod: 'bank', country: 'nl' }));
    expect(artist.country).toBe('NL');
    const moved = await a.as((ctx) => svc.updateArtist(ctx, artist.id, { status: 'onboarding' }));
    expect(moved).toMatchObject({ status: 'onboarding', payoutMethod: 'bank', country: 'NL' });
    expect(moved.onboardingStartedAt).not.toBeNull();
  });

  it('tracks onboarding steps and says what is next', async () => {
    const a = await makeOrg('Onboarding Label');
    const artist = await a.as((ctx) => svc.createArtist(ctx, { name: 'Selene Park', status: 'onboarding' }));
    let [row] = await a.as(svc.onboardingBoard);
    expect(row).toMatchObject({ done: 0, next: 'Complete artist profile (legal name, email, country)' });
    await a.as((ctx) => svc.updateOnboarding(ctx, artist.id, { profile: true, taxForm: true }));
    [row] = await a.as(svc.onboardingBoard);
    expect(row).toMatchObject({ done: 2, next: 'Payout details missing' });
    await a.as((ctx) => svc.updateOnboarding(ctx, artist.id, { next: 'Call the manager about the advance' }));
    [row] = await a.as(svc.onboardingBoard);
    expect(row.next).toBe('Call the manager about the advance');
  });

  it('reuses an existing artist by name or alias instead of duplicating', async () => {
    const a = await makeOrg('Alias Label');
    const original = await a.as((ctx) => svc.createArtist(ctx, { name: 'The Low Tides', aliases: ['Low Tides'] }));
    expect((await a.as((ctx) => svc.ensureArtist(ctx, 'the low tides'))).id).toBe(original.id);
    expect((await a.as((ctx) => svc.ensureArtist(ctx, 'Low Tides'))).id).toBe(original.id);
    expect((await a.as((ctx) => svc.ensureArtist(ctx, 'Juno Vale'))).id).not.toBe(original.id);
  });

  it('limits artist-scoped staff to their roster and checks permissions', async () => {
    const a = await makeOrg('Scoped Label');
    const [mine, theirs] = await a.as(async (ctx) => [await svc.createArtist(ctx, { name: 'Mine' }), await svc.createArtist(ctx, { name: 'Theirs' })]);
    const scoped = (fn: Parameters<typeof withOrg>[1]) => withOrg({ orgId: a.org.id, actor: { type: 'user', id: a.user.id, name: 'Manager' }, permissions: PermissionSet.forRole('manager'), artistScope: [mine.id] }, fn);
    const seen = (await scoped((ctx) => svc.listArtists(ctx, {}))) as Awaited<ReturnType<typeof svc.listArtists>>;
    expect(JSON.stringify(seen)).toContain('Mine');
    expect(JSON.stringify(seen)).not.toContain('Theirs');
    await expect(scoped((ctx) => svc.getArtist(ctx, theirs.id))).rejects.toBeInstanceOf(NotFoundError);

    const marketing = await addMember(a, 'marketing');
    await expect(marketing.as((ctx) => svc.createArtist(ctx, { name: 'Not allowed' }))).rejects.toBeInstanceOf(ForbiddenError);
  });
});
