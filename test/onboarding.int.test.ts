import { afterAll, describe, expect, it } from 'vitest';
import './modules';
import { closeDb } from '@labelconsole/core/db/client';
import { modules, type OnboardingStep } from '@labelconsole/core/modules';
import { closeQueues } from '@labelconsole/core/queue';
import { closeRedis } from '@labelconsole/core/redis';
import type { ServiceContext } from '@labelconsole/core/context';
import { createRelease } from '@labelconsole/catalogue/service';
import { createArtist } from '@labelconsole/people/service';
import { getWorkspace, inviteMember, setOnboardingHidden, updateWorkspace } from '@labelconsole/settings/service';
import { makeOrg } from './helpers';

afterAll(async () => {
  await closeQueues();
  await closeDb();
  await closeRedis();
});

async function steps(ctx: ServiceContext) {
  const out: OnboardingStep[] = [];
  for (const m of modules()) if (m.onboarding) out.push(...(await m.onboarding(ctx)));
  return Object.fromEntries(out.map((s) => [s.id, s.done]));
}

describe('getting-started checklist', () => {
  it('starts open, ticks off as the label sets up, and only counts its own data', async () => {
    const a = await makeOrg('Checklist Label');
    const b = await makeOrg('Busy Neighbour');
    await b.as(async (ctx) => {
      await createArtist(ctx, { name: 'Someone Else' });
      await createRelease(ctx, { title: 'Not Yours' });
    });

    expect(await a.as(steps)).toMatchObject({ label: false, team: false, artist: false, release: false, documents: false, agent: false });

    await a.as(async (ctx) => {
      await updateWorkspace(ctx, { legalEntity: 'Checklist Label Ltd', distributor: 'DistroKid' });
      await inviteMember(ctx, { email: 'teammate@example.test', role: 'marketing' });
      await createArtist(ctx, { name: 'First Signing' });
      await createRelease(ctx, { title: 'First Single' });
    });
    expect(await a.as(steps)).toMatchObject({ label: true, team: true, artist: true, release: true, documents: false });
  });

  it('can be hidden and shown again by someone who manages settings', async () => {
    const a = await makeOrg('Hide Label');
    await a.as((ctx) => setOnboardingHidden(ctx, true));
    expect((await a.as(getWorkspace)).settings.onboardingHiddenAt).toBeTruthy();
    await a.as((ctx) => setOnboardingHidden(ctx, false));
    expect((await a.as(getWorkspace)).settings.onboardingHiddenAt).toBeNull();
  });
});
